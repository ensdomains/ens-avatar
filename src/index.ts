import ERC1155 from './specs/erc1155';
import ERC721 from './specs/erc721';
import URI from './specs/uri';
import * as utils from './utils';
import {
  BaseError,
  createFetcher,
  getImageURI,
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
import { ChainClient } from './chain/client';

export const specs: { [key: string]: new () => Spec } = Object.freeze({
  erc721: ERC721,
  erc1155: ERC1155,
});

export interface UnsupportedNamespace {}
export class UnsupportedNamespace extends BaseError {}

export interface UnsupportedMediaKey {}
export class UnsupportedMediaKey extends BaseError {}

export interface AvatarResolver {
  client: ChainClient;
  options?: AvatarResolverOpts;
  fetcher: Fetcher;
  /**
   * Resolve an ENS name's `avatar` record to a displayable image reference.
   *
   * Returns a URL for remote raster/SVG images, or a sanitized
   * `data:image/svg+xml;base64,...` URI for inline/on-chain SVGs (scripts,
   * event handlers, and external references stripped).
   *
   * SECURITY: a **remote** SVG (an `http(s)` URL pointing at an SVG) is returned
   * as the raw URL and is NOT sanitized — render it in a sandboxed context
   * (`<img>`, CSS `background-image`, or `<image href>` in an SVG), or run the
   * fetched bytes through `utils.sanitizeSVG` before inlining into the DOM.
   *
   * @returns the image reference, or null if the name has no avatar record.
   */
  getAvatar(ens: string, data: AvatarRequestOpts): Promise<string | null>;
  /**
   * Resolve an ENS name's `header`/`banner` record to a displayable image
   * reference. Same return contract and remote-SVG caveat as `getAvatar`.
   */
  getHeader(ens: string, data: HeaderRequestOpts): Promise<string | null>;
  getMetadata(ens: string, key?: MediaKey): Promise<NFTMetadata | null>;
}

export class AvatarResolver implements AvatarResolver {
  constructor(client: ChainClient, options?: AvatarResolverOpts) {
    this.client = client;
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
    // resolve the avatar/header text record + owner address via the chain
    // client (CCIP-read and ENSIP-10 wildcard aware in the bundled adapters)
    const {
      record: mediaURI,
      address: resolvedAddress,
    } = await this.client.getEnsRecord(ens, key);
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
      this.client,
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
export { ChainClient, EnsRecord, ReadContractParams } from './chain/client';
// Public option/return types so consumers can write typed code against the API
// (AvatarResolverOpts, NFTMetadata, Fetcher, MediaKey, Gateways, Spec, …).
export * from './types';
