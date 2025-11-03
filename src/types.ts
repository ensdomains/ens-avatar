import { Provider } from 'ethers';

export interface Spec {
  getMetadata: (
    provider: Provider,
    ownerAddress: string | undefined | null,
    contractAddress: string,
    tokenID: string,
    options?: AvatarResolverOpts
  ) => Promise<any>;
}

export type MARKETPLACES = 'opensea' | 'coinbase' | 'looksrare' | 'x2y2';
export type MarketplaceAPIKey = Partial<
  {
    [key in MARKETPLACES]: string;
  }
>;

/**
 * Custom HTTP/HTTPS agents for Node.js environments
 *
 * SECURITY NOTE: When you provide custom agents, ens-avatar will use them as-is
 * without applying SSRF (Server-Side Request Forgery) protection. You are responsible
 * for ensuring your custom agents have appropriate security measures.
 *
 * If no custom agents are provided, ens-avatar creates default agents with built-in
 * SSRF protection that blocks requests to private IP addresses (localhost, 10.x.x.x,
 * 192.168.x.x, etc.) unless allowPrivateIPs is set to true.
 */
export interface AxiosAgents {
  httpAgent?: Function;
  httpsAgent?: Function;
}

export type MediaKey = 'avatar' | 'header' | 'banner';

/**
 * Configuration options for AvatarResolver
 *
 * SSRF PROTECTION:
 * By default, ens-avatar protects against Server-Side Request Forgery (SSRF) attacks
 * by blocking requests to private IP addresses. This behavior depends on your configuration:
 *
 * 1. No custom agents (default): SSRF protection enabled - blocks localhost, 10.x.x.x, etc.
 * 2. Custom agents provided: Uses your agents as-is - YOU are responsible for SSRF protection
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
   * Custom HTTP/HTTPS agents for Node.js
   * WARNING: When provided, SSRF protection is NOT applied to your custom agents.
   * You are responsible for securing your agents against SSRF attacks.
   */
  agents?: AxiosAgents;
  /** Maximum response content length in bytes */
  maxContentLength?: number;
  /**
   * Allow requests to private IP addresses (localhost, 127.0.0.1, 10.x.x.x, 192.168.x.x, etc.)
   *
   * WARNING: Only use this for local development (e.g., local IPFS nodes, test servers).
   * NEVER enable this in production as it disables SSRF protection.
   *
   * This flag is ignored if you provide custom agents (you control security in that case).
   *
   * @default false
   */
  allowPrivateIPs?: boolean;
}

export interface AvatarRequestOpts {
  jsdomWindow?: any;
}

export interface HeaderRequestOpts {
  jsdomWindow?: any;
  mediaKey?: Exclude<MediaKey, 'avatar'>;
}

export type Gateways = {
  ipfs?: string;
  arweave?: string;
};

export interface ImageURIOpts {
  metadata: any;
  customGateway?: string;
  gateways?: Gateways;
  jsdomWindow?: any;
  urlDenyList?: string[];
}
