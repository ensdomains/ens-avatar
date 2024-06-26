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
import { AvatarRequestOpts, AvatarResolverOpts, Spec } from './types';

export const specs: { [key: string]: new () => Spec } = Object.freeze({
  erc721: ERC721,
  erc1155: ERC1155,
});

export interface UnsupportedNamespace {}
export class UnsupportedNamespace extends BaseError {}

export interface AvatarResolver {
  provider: JsonRpcProvider;
  options?: AvatarResolverOpts;
  getAvatar(ens: string, data: AvatarRequestOpts): Promise<string | null>;
  getMetadata(ens: string): Promise<any | null>;
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
  }

  async getMetadata(ens: string) {
    // retrieve registrar address and resolver object from ens name
    const [resolvedAddress, resolver] = await handleSettled([
      this.provider.resolveName(ens),
      this.provider.getResolver(ens),
    ]);
    if (!resolver) return null;

    // retrieve 'avatar' text recored from resolver
    const avatarURI = await resolver.getText('avatar');
    if (!avatarURI) return null;

    // test case-insensitive in case of uppercase records
    if (!/eip155:/i.test(avatarURI)) {
      const uriSpec = new URI();
      const metadata = await uriSpec.getMetadata(avatarURI, this.options);
      return { uri: ens, ...metadata };
    }

    // parse retrieved avatar uri
    const { chainID, namespace, contractAddress, tokenID } = parseNFT(
      avatarURI
    );
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
    const metadata = await this.getMetadata(ens);
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
