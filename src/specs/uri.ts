import { AvatarResolverOpts } from '../types';
import { createFetcher, isImageURI, resolveURI } from '../utils';

export default class URI {
  async getMetadata(uri: string, options?: AvatarResolverOpts) {
    // Create a configured fetch instance for this request
    const fetch = createFetcher({
      ttl: options?.cache,
      agents: options?.agents,
      allowPrivateIPs: options?.allowPrivateIPs,
    });

    const { uri: resolvedURI, isOnChain } = resolveURI(uri, options);
    if (isOnChain) {
      return resolvedURI;
    }

    if (options?.urlDenyList?.includes(new URL(resolvedURI).hostname)) {
      return { image: null };
    }

    // check if resolvedURI is an image, if it is return the url
    const isImage = await isImageURI(resolvedURI);
    if (isImage) {
      return { image: resolvedURI };
    }

    // if resolvedURI is not an image, try retrieve the data.
    const response = await fetch.get(encodeURI(resolvedURI));
    return await response?.data;
  }
}
