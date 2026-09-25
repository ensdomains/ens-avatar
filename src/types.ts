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

export interface AxiosAgents {
  httpAgent?: Function;
  httpsAgent?: Function;
}

export type MediaKey = 'avatar' | 'header' | 'banner';

export interface AvatarResolverOpts {
  cache?: number;
  ipfs?: string;
  arweave?: string;
  apiKey?: MarketplaceAPIKey;
  urlDenyList?: string[];
  agents?: AxiosAgents;
  maxContentLength?: number;
  /** Gas limit for the tokenURI() / uri() calls. @default 10_000_000 */
  metadataGasLimit?: number;
  /** Maximum decoded inline SVG size in UTF-8 bytes. @default 1_000_000 */
  maxSvgBytes?: number;
  /** Maximum number of elements in an inline SVG. @default 20_000 */
  maxSvgElements?: number;
  /** Maximum number of attributes in an inline SVG. @default 40_000 */
  maxSvgAttributes?: number;
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
  /** Maximum decoded inline SVG size in UTF-8 bytes. @default 1_000_000 */
  maxSvgBytes?: number;
  /** Maximum number of elements in an inline SVG. @default 20_000 */
  maxSvgElements?: number;
  /** Maximum number of attributes in an inline SVG. @default 40_000 */
  maxSvgAttributes?: number;
}
