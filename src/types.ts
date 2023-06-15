import { BaseProvider } from '@ethersproject/providers';

export interface Spec {
  getMetadata: (
    provider: BaseProvider,
    ownerAddress: string | undefined | null,
    contractAddress: string,
    tokenID: string,
    options?: AvatarResolverOpts
  ) => Promise<any>;
}

export type MARKETPLACES = 'opensea' | 'coinbase' | 'looksrare' | 'x2y2';
export type MarketplaceAPIKey = Partial<{
  [key in MARKETPLACES]: string;
}>;

export interface AvatarResolverOpts {
  cache?: number;
  ipfs?: string;
  arweave?: string;
  apiKey?: MarketplaceAPIKey;
  urlDenyList?: string[];
}

export interface AvatarRequestOpts {
  jsdomWindow?: any;
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
