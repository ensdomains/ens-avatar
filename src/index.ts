import {
  Contract,
  dnsEncode,
  Interface,
  JsonRpcProvider,
  namehash,
} from 'ethers';
import ERC1155 from './specs/erc1155';
import ERC721 from './specs/erc721';
import URI from './specs/uri';
import * as utils from './utils';
import { BaseError, getImageURI, isImageURI, parseNFT } from './utils';
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
    // Note: fetch instance configuration is now handled in createFetcher
    // The global fetch instance already has proper configuration
    // This constructor no longer needs to modify the fetch instance
    // as options are passed directly to API methods that create their own instances
  }

  async getMetadata(ens: string, key: MediaKey = 'avatar') {
    const {
      resolver,
      resolvedAddress,
      mediaURI,
    } = await this._universalResolve(ens, key);

    if (!resolver || !mediaURI) return null;

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

  async _universalResolve(ens: string, key: MediaKey) {
    const universalResolverIface = new Interface([
      'function resolve(bytes name, bytes data) external view returns (bytes response, address resolver)',
    ]);

    const universalResolver = new Contract(
      '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
      universalResolverIface,
      this.provider
    );

    const resolverIface = new Interface([
      'function addr(bytes32 node, uint256 coinType) external view returns (bytes)',
      'function text(bytes32 node, string memory key) external view returns (string)',
    ]);

    const multicallIface = new Interface([
      'function multicall(bytes[] calldata data) external view returns (bytes[] memory results)',
    ]);

    // Combine the calls into a single multicall
    const resolveCalldata = multicallIface.encodeFunctionData('multicall', [
      [
        resolverIface.encodeFunctionData('addr', [namehash(ens), 60]),
        resolverIface.encodeFunctionData('text', [namehash(ens), key]),
      ],
    ]);

    // Get back the encoded response for each call, and the resolver address
    const [response, resolver] = await universalResolver.resolve(
      dnsEncode(ens),
      resolveCalldata,
      { enableCcipRead: true }
    );

    // Decode the multicall response into the encoded responses for each call
    const [
      [encodedAddr, encodedMediaURI],
    ] = multicallIface.decodeFunctionResult('multicall', response);

    return {
      resolver,
      // Decode the encoded responses for each call
      resolvedAddress: resolverIface
        .decodeFunctionResult('addr', encodedAddr)
        .toString(),
      mediaURI: resolverIface
        .decodeFunctionResult('text', encodedMediaURI)
        .toString(),
    };
  }
}

export { utils };
