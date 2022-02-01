import { BaseProvider } from '@ethersproject/providers';
import ERC1155 from './specs/erc1155';
import ERC721 from './specs/erc721';
import { createCacheAdapter, fetch, getImageURI, parseNFT } from './utils';
import URI from './specs/uri';

const SPECS: { [key: string]: any } = Object.freeze({
  erc721: ERC721,
  erc1155: ERC1155,
});

interface AvatarRequestOpts {
  ens: string;
}

interface AvatarResolverOpts {
  cache?: number;
  ipfs?: string;
}

export interface AvatarResolver {
  provider: BaseProvider;
  options?: AvatarResolverOpts;
  getAvatar(data: AvatarRequestOpts): Promise<string | null>;
  getMetadata(data: AvatarRequestOpts): Promise<string | null>;
}

export class AvatarResolver implements AvatarResolver {
  constructor(provider: BaseProvider, options?: AvatarResolverOpts) {
    this.provider = provider;
    this.options = options;
    if (options?.cache) {
      fetch.defaults.adapter = createCacheAdapter(options?.cache);
    }
  }

  async getMetadata({ ens }: AvatarRequestOpts) {
    // retrieve registrar address and resolver object from ens name
    const [registrarAddress, resolver] = await Promise.all([
      this.provider.resolveName(ens),
      this.provider.getResolver(ens),
    ]);
    if (!registrarAddress || !resolver) return null;

    // retrieve 'avatar' text recored from resolver
    const avatarURI = await resolver.getText('avatar');
    if (!avatarURI) return null;

    // test case-insensitive in case of uppercase records
    if (!/\/erc1155:|\/erc721:/i.test(avatarURI)) {
      const uriSpec = new URI();
      return await uriSpec.getMetadata(avatarURI);
    }

    // parse retrieved avatar uri
    const { namespace, contractAddress, tokenID } = parseNFT(avatarURI);
    // detect avatar spec by namespace
    const spec = new SPECS[namespace]();
    if (!spec) return null;

    // retrieve metadata
    const metadata = await spec.getMetadata(
      this.provider,
      registrarAddress,
      contractAddress,
      tokenID
    );
    return metadata;
  }

  async getAvatar(data: AvatarRequestOpts): Promise<string | null> {
    const metadata = await this.getMetadata(data);
    if (!metadata) return null;
    return getImageURI(metadata, this.options?.ipfs);
  }
}
