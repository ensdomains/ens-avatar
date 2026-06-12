import { Provider } from 'ethers';
import { Dispatcher } from 'undici';

export interface FetcherResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

export interface Fetcher {
  get<T = unknown>(
    url: string,
    opts?: { headers?: Record<string, string> }
  ): Promise<FetcherResponse<T>>;
  head(url: string): Promise<FetcherResponse<void>>;
  getArrayBuffer(
    url: string,
    opts?: { headers?: Record<string, string>; signal?: AbortSignal }
  ): Promise<FetcherResponse<ArrayBuffer>>;
}

export interface NFTMetadata {
  image?: string;
  image_url?: string;
  image_data?: string;
  [key: string]: unknown;
}

export interface Spec {
  getMetadata: (
    provider: Provider,
    ownerAddress: string | undefined | null,
    contractAddress: string,
    tokenID: string,
    options?: AvatarResolverOpts,
    fetcher?: Fetcher
  ) => Promise<NFTMetadata>;
}

export type MARKETPLACES = 'opensea' | 'coinbase' | 'looksrare' | 'x2y2';
export type MarketplaceAPIKey = Partial<
  {
    [key in MARKETPLACES]: string;
  }
>;

export type MediaKey = 'avatar' | 'header' | 'banner';

/**
 * Configuration options for AvatarResolver
 *
 * SSRF PROTECTION:
 * By default, ens-avatar protects against Server-Side Request Forgery (SSRF) attacks
 * by blocking requests to private IP addresses. This behavior depends on your configuration:
 *
 * 1. No custom dispatcher (default): SSRF protection enabled - blocks localhost, 10.x.x.x, etc.
 * 2. Custom dispatcher provided: Uses your dispatcher as-is - YOU are responsible for SSRF protection
 * 3. allowPrivateIPs: true: Disables SSRF protection - only for local development
 */
export interface AvatarResolverOpts {
  /** Cache time-to-live in seconds */
  cache?: number;
  /** Custom IPFS gateway URL */
  ipfs?: string;
  /** Custom Arweave gateway URL */
  arweave?: string;
  /** API keys for NFT marketplaces (OpenSea, etc.) */
  apiKey?: MarketplaceAPIKey;
  /** List of hostnames to block (in addition to SSRF protection) */
  urlDenyList?: string[];
  /**
   * Custom undici dispatcher for Node.js (e.g., custom Agent or Pool).
   * WARNING: When provided, SSRF protection is NOT applied.
   * You are responsible for securing your dispatcher against SSRF attacks.
   */
  dispatcher?: Dispatcher;
  /**
   * Allow requests to private IP addresses (localhost, 127.0.0.1, 10.x.x.x, 192.168.x.x, etc.)
   *
   * WARNING: Only use this for local development (e.g., local IPFS nodes, test servers).
   * NEVER enable this in production as it disables SSRF protection.
   *
   * This flag is ignored if you provide a custom dispatcher (you control security in that case).
   *
   * @default false
   */
  allowPrivateIPs?: boolean;
  /** HTTP request timeout in milliseconds @default 30000 */
  timeout?: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AvatarRequestOpts {
  // Reserved for future per-request options.
}

export interface HeaderRequestOpts {
  mediaKey?: Exclude<MediaKey, 'avatar'>;
}

export type Gateways = {
  ipfs?: string;
  arweave?: string;
};

export interface ImageURIOpts {
  metadata: NFTMetadata;
  customGateway?: string;
  gateways?: Gateways;
  urlDenyList?: string[];
}
