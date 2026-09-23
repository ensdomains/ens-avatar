import ERC1155 from './specs/erc1155';
import ERC721 from './specs/erc721';
import URI from './specs/uri';
import * as utils from './utils';
import {
  BaseError,
  createFetcherFromOptions,
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
import { toHttpURL } from './utils/url';

export const specs: { [key: string]: new () => Spec } = Object.freeze({
  erc721: ERC721,
  erc1155: ERC1155,
});

export interface UnsupportedNamespace {}
export class UnsupportedNamespace extends BaseError {}

export interface UnsupportedMediaKey {}
export class UnsupportedMediaKey extends BaseError {}

export interface ChainMismatch {}
export class ChainMismatch extends BaseError {}

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
    this.fetcher = createFetcherFromOptions(options);
  }

  async getMetadata(ens: string, key: MediaKey = 'avatar') {
    return (await this._resolveMetadata(ens, key)).metadata;
  }

  /**
   * getMetadata plus `verifiedImage`: the image URL already confirmed to be an
   * image while resolving (a record pointing straight at an image).
   */
  async _resolveMetadata(
    ens: string,
    key: MediaKey
  ): Promise<{ metadata: NFTMetadata | null; verifiedImage?: string }> {
    // resolve the avatar/header text record + owner address via the chain
    // client (CCIP-read and ENSIP-10 wildcard aware in the bundled adapters)
    const {
      record: mediaURI,
      address: resolvedAddress,
    } = await this.client.getEnsRecord(ens, key);
    if (!mediaURI) return { metadata: null };

    // test case-insensitive in case of uppercase records
    if (!/eip155:/i.test(mediaURI)) {
      const uriSpec = new URI();
      const { metadata, verifiedImage } = await uriSpec.getMetadata(
        mediaURI,
        this.options,
        this.fetcher
      );
      return { metadata: { ...metadata, uri: ens }, verifiedImage };
    }

    // parse retrieved avatar uri
    const { chainID, namespace, contractAddress, tokenID } = parseNFT(mediaURI);
    // detect avatar spec by namespace — use hasOwnProperty to prevent
    // prototype pollution via __proto__/constructor namespace injection
    if (!Object.prototype.hasOwnProperty.call(specs, namespace)) {
      throw new UnsupportedNamespace(`Unsupported namespace: ${namespace}`);
    }
    // The contract lives on `chainID`; reading the same address on another
    // chain would return another contract's data (and a wrong is_owner).
    if (this.client.getChainId) {
      const clientChainId = await this.client.getChainId();
      if (clientChainId !== chainID) {
        throw new ChainMismatch(
          `NFT is on chain ${chainID} but the client reads chain ${clientChainId}`
        );
      }
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
    return { metadata: { ...metadata, uri: ens, host_meta } };
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
    const { metadata, verifiedImage } = await this._resolveMetadata(
      ens,
      mediaKey
    );
    if (!metadata) return null;
    const imageURI = getImageURI({
      metadata,
      gateways: {
        ipfs: this.options?.ipfs,
        arweave: this.options?.arweave,
      },
      urlDenyList: this.options?.urlDenyList,
    });
    // Every remote URL we return must be an image. Skip only the URL the
    // record pointed at directly, which was checked while resolving.
    if (imageURI && toHttpURL(imageURI) && imageURI !== verifiedImage) {
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
