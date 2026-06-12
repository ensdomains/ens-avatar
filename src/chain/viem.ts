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
  readContract(args: {
    address: string;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
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
  return {
    async getEnsRecord(name: string, key: string): Promise<EnsRecord> {
      const [record, address] = await Promise.all([
        client
          .getEnsText({
            name,
            key,
            universalResolverAddress: opts?.universalResolverAddress,
          })
          .catch(() => null),
        client
          .getEnsAddress({
            name,
            universalResolverAddress: opts?.universalResolverAddress,
          })
          .catch(() => null),
      ]);
      return { record: record ?? null, address: address ?? null };
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
