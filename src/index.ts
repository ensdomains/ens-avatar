import { JsonRpcProvider } from 'ethers';
import ERC1155 from './specs/erc1155';
import ERC721 from './specs/erc721';
import URI from './specs/uri';
import * as utils from './utils';
import {
  BaseError,
  createFetcher,
  getImageURI,
  handleSettled,
  isImageURI,
  parseNFT,
} from './utils';
import {
  AvatarRequestOpts,
  AvatarResolverOpts,
  Fetcher,
  HeaderRequestOpts,
  MediaKey,
  NFTMetadata,
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
  fetcher: Fetcher;
  getAvatar(ens: string, data: AvatarRequestOpts): Promise<string | null>;
  getHeader(ens: string, data: HeaderRequestOpts): Promise<string | null>;
  getMetadata(ens: string, key?: MediaKey): Promise<NFTMetadata | null>;
}

export class AvatarResolver implements AvatarResolver {
  constructor(provider: JsonRpcProvider, options?: AvatarResolverOpts) {
    this.provider = provider;
    this.options = options;
    this.fetcher = createFetcher({
      ttl: options?.cache,
      dispatcher: options?.dispatcher,
      allowPrivateIPs: options?.allowPrivateIPs,
      timeout: options?.timeout,
      urlDenyList: options?.urlDenyList,
    });
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
      const metadata = await uriSpec.getMetadata(
        mediaURI,
        this.options,
        this.fetcher
      );
      return {
        ...(typeof metadata === 'object' ? metadata : { image: metadata }),
        uri: ens,
      };
    }

    // parse retrieved avatar uri
    const { chainID, namespace, contractAddress, tokenID } = parseNFT(mediaURI);
    // detect avatar spec by namespace — use hasOwnProperty to prevent
    // prototype pollution via __proto__/constructor namespace injection
    if (!Object.prototype.hasOwnProperty.call(specs, namespace)) {
      throw new UnsupportedNamespace(`Unsupported namespace: ${namespace}`);
    }
    const Spec = specs[namespace];
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
      this.options,
      this.fetcher
    );
    return { ...metadata, uri: ens, host_meta };
  }

  async getAvatar(
    ens: string,
    _data?: AvatarRequestOpts
  ): Promise<string | null> {
    return this._getMedia(ens, 'avatar');
  }

  async getHeader(
    ens: string,
    data?: HeaderRequestOpts
  ): Promise<string | null> {
    const mediaKey = data?.mediaKey || 'header';
    if (!['header', 'banner'].includes(mediaKey)) {
      throw new UnsupportedMediaKey('Unsupported media key');
    }
    return this._getMedia(ens, mediaKey);
  }

  async _getMedia(ens: string, mediaKey: MediaKey = 'avatar') {
    const metadata = await this.getMetadata(ens, mediaKey);
    if (!metadata) return null;
    const imageURI = getImageURI({
      metadata,
      gateways: {
        ipfs: this.options?.ipfs,
        arweave: this.options?.arweave,
      },
      urlDenyList: this.options?.urlDenyList,
    });
    if (
      // do check only NFTs since raw uri has this check built-in
      metadata.hasOwnProperty('host_meta') &&
      imageURI?.startsWith('http')
    ) {
      const isImage = await isImageURI(imageURI, this.fetcher);
      return isImage ? imageURI : null;
    }
    return imageURI;
  }
}

export { utils };
