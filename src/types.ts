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

export interface AvatarResolverOpts {
  cache?: number;
  ipfs?: string;
  arweave?: string;
  apiKey?: MarketplaceAPIKey;
  urlDenyList?: string[];
  agents?: AxiosAgents;
  maxContentLength?: number;
}

export interface AvatarRequestOpts {
  jsdomWindow?: any;
}

export interface HeaderRequestOpts {
  jsdomWindow?: any;
  mediaKey?: 'header' | 'banner';
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
