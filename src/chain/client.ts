/**
 * ChainClient — the minimal chain-access surface ens-avatar needs.
 *
 * The library core depends on this interface only; it imports neither ethers
 * nor viem. Bring your own adapter:
 *   - `fromEthers(provider)` from `@ensdomains/ens-avatar/ethers`
 *   - `fromViem(client)`     from `@ensdomains/ens-avatar/viem`
 * or implement ChainClient yourself.
 */

/** The result of resolving an ENS name's text record. */
export interface EnsRecord {
  /** The requested text record value (e.g. the `avatar`/`header` URI), or null. */
  record: string | null;
  /** The name's resolved ETH address, used for NFT ownership checks, or null. */
  address: string | null;
}

/** Parameters for a single read-only contract call. */
export interface ReadContractParams {
  /** Contract address. */
  address: string;
  /** JSON ABI fragments (accepted as-is by both ethers and viem). */
  abi: readonly unknown[];
  /** Function name to call. */
  functionName: string;
  /** Function arguments. */
  args: readonly unknown[];
}

export interface ChainClient {
  /**
   * Resolve an ENS name's text record and ETH address in one logical step.
   * Implementations should be CCIP-read aware and must return null fields
   * (rather than throwing) when the name has no resolver or no record.
   */
  getEnsRecord(name: string, key: string): Promise<EnsRecord>;

  /** Call a read-only contract function and return its decoded result. */
  readContract<T = unknown>(params: ReadContractParams): Promise<T>;
}
