import { JsonRpcProvider } from 'ethers';
import ERC1155 from './specs/erc1155';
import ERC721 from './specs/erc721';
import URI from './specs/uri';
import * as utils from './utils';
import {
  BaseError,
  createAgentAdapter,
  createCacheAdapter,
  fetch,
  getImageURI,
  handleSettled,
  isImageURI,
  parseNFT,
} from './utils';
import {
  AvatarRequestOpts,
  AvatarResolverOpts,
  HeaderRequestOpts,
  MediaKey,
  Spec,
} from './types';

export const specs: { [key: string]: new () => Spec } = Object.freeze({
  erc721: ERC721,
  erc1155: ERC1155,
});

export interface UnsupportedNamespace {}
export class UnsupportedNamespace extends BaseError {}

export interface UnsupportedMediaKey {}
export class UnsupportedMediaKey extends BaseError {}

export interface AvatarResolver {
  provider: JsonRpcProvider;
  options?: AvatarResolverOpts;
  getAvatar(ens: string, data: AvatarRequestOpts): Promise<string | null>;
  getHeader(ens: string, data: HeaderRequestOpts): Promise<string | null>;
  getMetadata(ens: string, key?: MediaKey): Promise<any | null>;
}

export class AvatarResolver implements AvatarResolver {
  constructor(provider: JsonRpcProvider, options?: AvatarResolverOpts) {
    this.provider = provider;
    this.options = options;
    if (options?.cache && options?.cache > 0) {
      createCacheAdapter(fetch, options?.cache);
    }
    if (options?.agents) {
      createAgentAdapter(fetch, options?.agents);
    }

    if (options?.maxContentLength && options?.maxContentLength > 0) {
      fetch.defaults.maxContentLength = options?.maxContentLength;
    }
  }

  async getMetadata(ens: string, key: MediaKey = 'avatar') {
    // retrieve registrar address and resolver object from ens name
    const [resolvedAddress, resolver] = await handleSettled([
      this.provider.resolveName(ens),
      this.provider.getResolver(ens),
    ]);
    if (!resolver) return null;

    // retrieve 'avatar' text recored from resolver
    const mediaURI = await resolver.getText(key);
    if (!mediaURI) return null;

    // test case-insensitive in case of uppercase records
    if (!/eip155:/i.test(mediaURI)) {
      const uriSpec = new URI();
      const metadata = await uriSpec.getMetadata(mediaURI, this.options);
      return { uri: ens, ...metadata };
    }

    // parse retrieved avatar uri
    const { chainID, namespace, contractAddress, tokenID } = parseNFT(mediaURI);
    // detect avatar spec by namespace
    const Spec = specs[namespace];
    if (!Spec)
      throw new UnsupportedNamespace(`Unsupported namespace: ${namespace}`);
    const spec = new Spec();

    // add meta information of the avatar record
    const host_meta = {
      chain_id: chainID,
      namespace,
      contract_address: contractAddress,
      token_id: tokenID,
      reference_url: `https://opensea.io/assets/${contractAddress}/${tokenID}`,
    };

    // retrieve metadata
    const metadata = await spec.getMetadata(
      this.provider,
      resolvedAddress,
      contractAddress,
      tokenID,
      this.options
    );
    return { uri: ens, host_meta, ...metadata };
  }

  async getAvatar(
    ens: string,
    data?: AvatarRequestOpts
  ): Promise<string | null> {
    return this._getMedia(ens, 'avatar', data);
  }

  async getHeader(
    ens: string,
    data?: HeaderRequestOpts
  ): Promise<string | null> {
    const mediaKey = data?.mediaKey || 'header';
    if (!['header', 'banner'].includes(mediaKey)) {
      throw new UnsupportedMediaKey('Unsupported media key');
    }
    return this._getMedia(ens, mediaKey, data);
  }

  async _getMedia(
    ens: string,
    mediaKey: MediaKey = 'avatar',
    data?: HeaderRequestOpts
  ) {
    const metadata = await this.getMetadata(ens, mediaKey);
    if (!metadata) return null;
    const imageURI = getImageURI({
      metadata,
      gateways: {
        ipfs: this.options?.ipfs,
        arweave: this.options?.arweave,
      },
      jsdomWindow: data?.jsdomWindow,
      urlDenyList: this.options?.urlDenyList,
    });
    if (
      // do check only NFTs since raw uri has this check built-in
      metadata.hasOwnProperty('host_meta') &&
      imageURI?.startsWith('http')
    ) {
      const isImage = await isImageURI(imageURI);
      return isImage ? imageURI : null;
    }
    return imageURI;
  }
}

export { utils };
