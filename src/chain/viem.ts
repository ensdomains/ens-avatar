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
  /** viem's `getChainId` action, used when `chain` is not set. */
  getChainId?(): Promise<number>;
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
  let fetchedChainId: number | undefined;
  const canGetChainId = !!client.chain || !!client.getChainId;

  return {
    getChainId: canGetChainId
      ? async () => {
          if (client.chain) return client.chain.id;
          if (fetchedChainId === undefined) {
            fetchedChainId = await client.getChainId!();
          }
          return fetchedChainId;
        }
      : undefined,

    async getEnsRecord(name: string, key: string): Promise<EnsRecord> {
      // viem already returns null when the name has no resolver or record.
      // Anything it throws is a real failure (RPC, gateway).
      const [record, address] = await Promise.allSettled([
        client.getEnsText({
          name,
          key,
          universalResolverAddress: opts?.universalResolverAddress,
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
