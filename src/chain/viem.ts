/**
 * viem adapter for ens-avatar's ChainClient.
 *
 * Import from `@ensdomains/ens-avatar/viem`. It depends only on a structural
 * subset of a viem PublicClient (see ViemClientLike), so it does not pull in
 * the viem package at build time — a real `createPublicClient(...)` satisfies
 * the shape and CCIP-read / wildcard resolution is handled natively by viem.
 */
import { ChainClient, EnsRecord, ReadContractParams } from './client';

/** The subset of a viem PublicClient that ens-avatar uses. */
export interface ViemClientLike {
  getEnsText(args: {
    name: string;
    key: string;
    universalResolverAddress?: string;
    strict?: boolean;
  }): Promise<string | null>;
  getEnsAddress(args: {
    name: string;
    universalResolverAddress?: string;
  }): Promise<string | null>;
  // `address` is `any` and `args` is optional so that a stock viem
  // `PublicClient` (whose `readContract` is heavily generic, with `address`
  // typed as the 0x-prefixed `Address`) structurally satisfies this interface —
  // consumers can pass `createPublicClient(...)` straight to `fromViem` with no
  // `as unknown as ViemClientLike` cast. `address` can't be the precise
  // `` `0x${string}` `` template-literal type here because the repo's `tsdx`
  // lint parser predates template-literal type syntax.
  readContract(args: {
    address: any;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  /** The client's configured chain; when set, NFT chain ids are enforced. */
  chain?: { id: number };
  /** viem's `getChainId` action; fallback when neither `chain` nor `request`. */
  getChainId?(): Promise<number>;
  /** The client's EIP-1193 `request`, used to ask for eth_chainId. */
  request?(...args: any[]): Promise<unknown>;
}

// Universal Resolver errors that mean "no such resolver/record/profile".
// (Non-strict viem also treats HttpError — a failed CCIP gateway — as null,
// which would make a gateway outage read as "no avatar".)
const NO_RESULT_ERRORS = new Set([
  'ResolverNotFound',
  'ResolverNotContract',
  'ResolverError',
  'UnsupportedResolverProfile',
  'ReverseAddressMismatch',
]);

/** The decoded custom-error name inside a viem error, if any. */
function contractErrorName(error: unknown): string | undefined {
  const walk = (error as { walk?: (fn: (e: unknown) => boolean) => unknown })
    ?.walk;
  if (typeof walk !== 'function') return undefined;
  const hasName = (e: unknown) =>
    typeof (e as { data?: { errorName?: unknown } })?.data?.errorName ===
    'string';
  const cause = walk.call(error, hasName) as
    | { data?: { errorName?: string } }
    | undefined;
  return cause?.data?.errorName;
}

// How long to wait for eth_chainId before giving up.
const CHAIN_ID_TIMEOUT_MS = 10000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('eth_chainId timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface FromViemOptions {
  /** Override the ENS Universal Resolver address (passed through to viem). */
  universalResolverAddress?: string;
}

/**
 * Adapt a viem PublicClient to ens-avatar's ChainClient.
 *
 * Note: viem expects ENS names to be normalized (ENSIP-15) by the caller.
 */
export function fromViem(
  client: ViemClientLike,
  opts?: FromViemOptions
): ChainClient {
  // Cache the settled number, never a pending promise: in Cloudflare Workers a
  // promise created while serving one request hangs when awaited by another.
  // For the same reason eth_chainId is sent with viem's request dedupe off
  // (getChainId dedupes, so it could hand back another request's promise).
  let fetchedChainId: number | undefined;
  const canGetChainId = !!(client.chain || client.request || client.getChainId);

  const fetchChainId = async (): Promise<number> => {
    if (client.request) {
      const hex = await withTimeout(
        client.request({ method: 'eth_chainId' }, { dedupe: false }),
        CHAIN_ID_TIMEOUT_MS
      );
      return Number(hex);
    }
    return withTimeout(client.getChainId!(), CHAIN_ID_TIMEOUT_MS);
  };

  return {
    getChainId: canGetChainId
      ? async () => {
          if (client.chain) return client.chain.id;
          if (fetchedChainId === undefined)
            fetchedChainId = await fetchChainId();
          return fetchedChainId;
        }
      : undefined,

    async getEnsRecord(name: string, key: string): Promise<EnsRecord> {
      // strict: a missing resolver/record comes back as a UR custom error,
      // mapped to null here; anything else (RPC, gateway) is a real failure.
      const [record, address] = await Promise.allSettled([
        client
          .getEnsText({
            name,
            key,
            universalResolverAddress: opts?.universalResolverAddress,
            strict: true,
          })
          .catch(error => {
            const errorName = contractErrorName(error);
            if (errorName && NO_RESULT_ERRORS.has(errorName)) return null;
            throw error;
          }),
        client.getEnsAddress({
          name,
          universalResolverAddress: opts?.universalResolverAddress,
        }),
      ]);
      // A failed record lookup must surface, or an outage would read as "no
      // avatar". The address only feeds the ownership check, so without it the
      // avatar still resolves (with is_owner false).
      if (record.status === 'rejected') throw record.reason;
      return {
        record: record.value ?? null,
        address: address.status === 'fulfilled' ? address.value ?? null : null,
      };
    },

    async readContract<T = unknown>({
      address,
      abi,
      functionName,
      args,
    }: ReadContractParams): Promise<T> {
      return client.readContract({
        address,
        abi,
        functionName,
        args,
      }) as Promise<T>;
    },
  };
}
