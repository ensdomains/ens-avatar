import { AvatarResolverOpts, Fetcher } from '../types';
import { BaseError, createFetcher, isImageURI, resolveURI } from '../utils';
import { isHostDenied } from '../utils/isHostDenied';
import { isURIEncoded } from '../utils/isImageURI';

export default class URI {
  async getMetadata(
    uri: string,
    options?: AvatarResolverOpts,
    fetcher?: Fetcher
  ) {
    // Use provided fetcher or create a new one
    const fetch =
      fetcher ||
      createFetcher({
        ttl: options?.cache,
        dispatcher: options?.dispatcher,
        allowPrivateIPs: options?.allowPrivateIPs,
        timeout: options?.timeout,
        urlDenyList: options?.urlDenyList,
      });

    const { uri: resolvedURI, isOnChain } = resolveURI(uri, {
      ipfs: options?.ipfs,
      arweave: options?.arweave,
    });
    if (isOnChain) {
      return resolvedURI;
    }

    if (isHostDenied(resolvedURI, options?.urlDenyList)) {
      return { image: null };
    }

    // check if resolvedURI is an image, if it is return the url
    const isImage = await isImageURI(resolvedURI, fetch);
    if (isImage) {
      return { image: resolvedURI };
    }

    // if resolvedURI is not an image, try retrieve the data.
    const finalURI = isURIEncoded(resolvedURI)
      ? resolvedURI
      : encodeURI(resolvedURI);
    const response = await fetch.get(finalURI);
    if (!response?.data) {
      throw new BaseError('Failed to retrieve metadata from URI');
    }
    return await response?.data;
  }
}
