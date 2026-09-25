import { AvatarResolverOpts, Fetcher, NFTMetadata } from '../types';
import {
  BaseError,
  createFetcherFromOptions,
  isImageURI,
  resolveURI,
} from '../utils';
import { isHostDenied } from '../utils/isHostDenied';
import {
  asMetadataObject,
  assertDataURISize,
  parseOnChainMetadata,
} from '../utils/parseOnChainMetadata';
import { toHttpURL } from '../utils/url';

// Fields the resolver sets itself. A record's own JSON must not supply them
// (e.g. a fake is_owner / host_meta for a name that owns no NFT).
const RESERVED_KEYS = ['is_owner', 'host_meta', 'uri'];

function recordMetadata(value: Record<string, unknown>): NFTMetadata {
  const metadata: Record<string, unknown> = { ...value };
  for (const key of RESERVED_KEYS) delete metadata[key];
  return metadata as NFTMetadata;
}

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

    if (/^data:application\/json[;,]/i.test(uri)) {
      assertDataURISize(uri, options?.maxContentLength);
    }
    const { uri: resolvedURI, isOnChain, isEncoded } = resolveURI(uri, {
      ipfs: options?.ipfs,
      arweave: options?.arweave,
    });
    if (isOnChain) {
      // An inline JSON document is metadata (its `image` is resolved next);
      // anything else inline (e.g. an <svg> or data:image URI) is the image.
      if (/^data:application\/json[;,]/i.test(uri)) {
        return {
          metadata: recordMetadata(
            parseOnChainMetadata(
              resolvedURI,
              isEncoded,
              options?.maxContentLength
            )
          ),
        };
      }
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
    // A bare JSON string is taken as the image URL.
    const data = response.data;
    return {
      metadata:
        typeof data === 'string'
          ? { image: data }
          : recordMetadata(asMetadataObject(data)),
    };
  }
}
