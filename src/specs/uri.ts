import { AvatarResolverOpts } from '..';
import { fetch, isImageURI, resolveURI } from '../utils';

export default class URI {
  async getMetadata(uri: string, options?: AvatarResolverOpts) {
    const { uri: resolvedURI, isOnChain } = resolveURI(uri, options);
    if (isOnChain) {
      return resolvedURI;
    }

    // check if resolvedURI is an image, if it is return the url
    const isImage = await isImageURI(resolvedURI);
    if (isImage) {
      return { image: resolvedURI };
    }

    // if resolvedURI is not an image, try retrieve the data.
    const response = await fetch(resolvedURI);
    return await response?.data;
  }
}
