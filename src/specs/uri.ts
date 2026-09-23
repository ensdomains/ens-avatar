import { AvatarResolverOpts, Fetcher, NFTMetadata } from '../types';
import {
  BaseError,
  createFetcherFromOptions,
  isImageURI,
  resolveURI,
} from '../utils';
import { isHostDenied } from '../utils/isHostDenied';
import { toHttpURL } from '../utils/url';

export default class URI {
  /**
   * Resolve a non-NFT media record. `verifiedImage` is set when the record
   * itself was confirmed to be an image, so callers need not check it again.
   */
  async getMetadata(
    uri: string,
    options?: AvatarResolverOpts,
    fetcher?: Fetcher
  ): Promise<{ metadata: NFTMetadata; verifiedImage?: string }> {
    // Use provided fetcher or create a new one
    const fetch = fetcher || createFetcherFromOptions(options);

    const { uri: resolvedURI, isOnChain } = resolveURI(uri, {
      ipfs: options?.ipfs,
      arweave: options?.arweave,
    });
    if (isOnChain) {
      return { metadata: { image: resolvedURI } };
    }

    const url = toHttpURL(resolvedURI);
    if (!url || isHostDenied(url, options?.urlDenyList)) {
      return { metadata: ({ image: null } as unknown) as NFTMetadata };
    }

    // check if the URL is an image, if it is return the url
    if (await isImageURI(url, fetch)) {
      return { metadata: { image: url }, verifiedImage: url };
    }

    // if the URL is not an image, try retrieve the metadata JSON.
    const response = await fetch.get(url);
    if (!response?.data) {
      throw new BaseError('Failed to retrieve metadata from URI');
    }
    const data = response.data;
    return {
      metadata: (typeof data === 'object'
        ? data
        : { image: data }) as NFTMetadata,
    };
  }
}
