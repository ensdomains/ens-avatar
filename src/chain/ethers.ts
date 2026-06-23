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

  return {
    async getEnsRecord(name: string, key: string): Promise<EnsRecord> {
      const node = namehash(name);
      const dnsName = dnsEncode(name);

      // One UR resolve() call. Returns null when the name has no resolver or
      // the call reverts (so callers get null instead of an exception).
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
        } catch {
          return null;
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
        try {
          const [results] = multicallIface.decodeFunctionResult(
            'multicall',
            batched.response
          );
          const [encodedAddr, encodedText] = results as string[];
          return {
            record: decodeText(encodedText),
            address: decodeAddr(encodedAddr),
          };
        } catch {
          // multicall result didn't decode — fall through to the text-only path
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
