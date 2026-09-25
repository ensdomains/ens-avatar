/**
 * ethers adapter for ens-avatar's ChainClient.
 *
 * Import from `@ensdomains/ens-avatar/ethers`. This is the only place the
 * library touches ethers, so the core bundle stays ethers-free.
 */
import {
  Contract,
  Interface,
  InterfaceAbi,
  Provider,
  ZeroAddress,
  dnsEncode,
  getAddress,
  id,
  isError,
  namehash,
} from 'ethers';
import { ChainClient, EnsRecord, ReadContractParams } from './client';

// Canonical ENS Universal Resolver (ENSIP-23). Same address on mainnet/Sepolia.
const UNIVERSAL_RESOLVER_ADDRESS = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';

export interface FromEthersOptions {
  /**
   * Override the ENS Universal Resolver contract address. Defaults to the
   * canonical deployment. Set this for networks/local deployments where the
   * provider's chain has a different (or no) deployment.
   */
  universalResolverAddress?: string;
}

// Universal Resolver custom errors that mean "no such resolver / record /
// profile". JSON-RPC errors (which ethers also reports as CALL_EXCEPTION, e.g.
// "header not found" or rate limits) and any other revert are failures.
const NO_RESULT_SELECTORS = new Set(
  [
    'ResolverNotFound(bytes)',
    'ResolverNotContract(bytes,address)',
    'UnsupportedResolverProfile(bytes4)',
    'ResolverError(bytes)',
  ].map(signature => id(signature).slice(0, 10))
);
// A CCIP gateway failed. 404/410 mean the name isn't there (as in the viem
// adapter, and as ethers' own CCIP-read treats a 4xx); other statuses throw.
const HTTP_ERROR = id('HttpError(uint16,string)').slice(0, 10);
const INVALID_BATCH_GATEWAY_RESPONSE = id(
  'InvalidBatchGatewayResponse()'
).slice(0, 10);
const NOT_FOUND_STATUSES = new Set([404, 410]);
const gatewayErrors = new Interface([
  'error HttpError(uint16 status, string message)',
]);

const selectorOf = (data: string) => data.slice(0, 10).toLowerCase();

function isNotFoundHttpError(data: string): boolean {
  try {
    const [status] = gatewayErrors.decodeErrorResult('HttpError', data);
    return NOT_FOUND_STATUSES.has(Number(status));
  } catch {
    return false;
  }
}

/** True if a failed Universal Resolver call means "no result". */
function isNoResult(error: unknown): boolean {
  if (!isError(error, 'CALL_EXCEPTION') || !error.data) return false;
  const selector = selectorOf(error.data);
  if (NO_RESULT_SELECTORS.has(selector)) return true;
  return selector === HTTP_ERROR && isNotFoundHttpError(error.data);
}

/**
 * Classify one result of the UR multicall. UR v3 reports a failed call by
 * putting its revert data in place of the result, inside an otherwise
 * successful response. Revert data is a 4-byte selector plus ABI words; return
 * data is whole 32-byte words.
 *
 * - 'ok': the call succeeded (`data` is its result)
 * - 'none': no result (a "no result" UR error, or a gateway 404/410)
 * - 'failed': a CCIP gateway failed (other HttpError statuses,
 *   InvalidBatchGatewayResponse)
 * - 'ambiguous': anything else, e.g. Error(string). Inside the multicall a
 *   resolver's own revert and a batch-gateway network failure (timeout,
 *   unreachable, garbage body) look the same; resolving the call on its own
 *   tells them apart, since the UR then wraps a resolver revert in
 *   ResolverError and passes a gateway failure through.
 */
type CallResult =
  | { kind: 'ok'; data: string }
  | { kind: 'none' | 'failed' | 'ambiguous'; data: string };

function classifyCallResult(data: string): CallResult {
  if (((data.length - 2) / 2) % 32 !== 4) return { kind: 'ok', data };
  const selector = selectorOf(data);
  if (NO_RESULT_SELECTORS.has(selector)) return { kind: 'none', data };
  if (selector === HTTP_ERROR) {
    return { kind: isNotFoundHttpError(data) ? 'none' : 'failed', data };
  }
  if (selector === INVALID_BATCH_GATEWAY_RESPONSE) {
    return { kind: 'failed', data };
  }
  return { kind: 'ambiguous', data };
}

const callFailed = (data: string) =>
  Object.assign(
    new Error(`Universal Resolver call failed (${selectorOf(data)})`),
    { data }
  );

/** Adapt an ethers v6 Provider to ens-avatar's ChainClient. */
export function fromEthers(
  provider: Provider,
  opts?: FromEthersOptions
): ChainClient {
  const universalResolver = new Contract(
    opts?.universalResolverAddress || UNIVERSAL_RESOLVER_ADDRESS,
    [
      'function resolve(bytes name, bytes data) external view returns (bytes, address)',
    ],
    provider
  );
  const resolverIface = new Interface([
    'function addr(bytes32 node, uint256 coinType) external view returns (bytes)',
    'function text(bytes32 node, string key) external view returns (string)',
  ]);
  const multicallIface = new Interface([
    'function multicall(bytes[] data) external view returns (bytes[])',
  ]);

  // Cache the settled number, never a pending promise: in Cloudflare Workers a
  // promise created while serving one request hangs when awaited by another.
  let chainId: number | undefined;

  return {
    async getChainId() {
      if (chainId === undefined) {
        chainId = Number((await provider.getNetwork()).chainId);
      }
      return chainId;
    },

    async getEnsRecord(name: string, key: string): Promise<EnsRecord> {
      const node = namehash(name);
      const dnsName = dnsEncode(name);

      // One UR resolve() call. Returns null when the call reverts (no
      // resolver, unsupported profile, …); rethrows RPC/gateway failures so an
      // outage doesn't read as "no avatar".
      const resolve = async (
        data: string
      ): Promise<{ response: string; resolver: string } | null> => {
        try {
          const [response, resolver] = await universalResolver.resolve(
            dnsName,
            data,
            { enableCcipRead: true }
          );
          if (!resolver || resolver === ZeroAddress) return null;
          return { response, resolver };
        } catch (error) {
          if (isNoResult(error)) return null;
          throw error;
        }
      };

      const decodeText = (encoded: string): string | null => {
        try {
          return (
            (resolverIface.decodeFunctionResult(
              'text',
              encoded
            )[0] as string) || null
          );
        } catch {
          return null;
        }
      };
      const decodeAddr = (encoded: string): string | null => {
        try {
          const bytes = resolverIface.decodeFunctionResult(
            'addr',
            encoded
          )[0] as string;
          return bytes && bytes !== '0x' ? getAddress(bytes) : null;
        } catch {
          return null;
        }
      };

      const textCalldata = resolverIface.encodeFunctionData('text', [
        node,
        key,
      ]);
      const addrCalldata = resolverIface.encodeFunctionData('addr', [node, 60]);

      // Fast path: batch addr(node, 60) + text(node, key) in a single multicall.
      const batched = await resolve(
        multicallIface.encodeFunctionData('multicall', [
          [addrCalldata, textCalldata],
        ])
      );
      if (batched) {
        let results: string[] | undefined;
        try {
          results = multicallIface.decodeFunctionResult(
            'multicall',
            batched.response
          )[0] as string[];
        } catch {
          // multicall result didn't decode — fall through to the text-only path
        }
        if (results) {
          const [encodedAddr, encodedText] = results;
          // A failed addr call only costs the ownership check.
          const addr = classifyCallResult(encodedAddr);
          const address = addr.kind === 'ok' ? decodeAddr(addr.data) : null;
          const text = classifyCallResult(encodedText);
          switch (text.kind) {
            case 'ok':
              return { record: decodeText(text.data), address };
            case 'none':
              return { record: null, address };
            case 'failed':
              throw callFailed(text.data);
            case 'ambiguous': {
              // Resolve the text record on its own: resolve() returns null for
              // ResolverError (the resolver reverted) and throws for a gateway
              // failure.
              const retried = await resolve(textCalldata);
              return {
                record: retried ? decodeText(retried.response) : null,
                address,
              };
            }
          }
        }
      }

      // Fallback: resolvers that don't implement addr(bytes32, uint256) revert
      // the batched multicall. Resolve the text record on its own (ownership
      // check is skipped, since we have no address).
      const textOnly = await resolve(textCalldata);
      if (!textOnly) return { record: null, address: null };
      return { record: decodeText(textOnly.response), address: null };
    },

    async readContract<T = unknown>({
      address,
      abi,
      functionName,
      args,
    }: ReadContractParams): Promise<T> {
      const contract = new Contract(
        address,
        (abi as unknown) as InterfaceAbi,
        provider
      );
      return contract[functionName](...args) as Promise<T>;
    },
  };
}
