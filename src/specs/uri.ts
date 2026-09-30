import { AvatarResolverOpts } from '../types';
import {
  METADATA_REQUEST_LIMITS,
  assertMetadataSize,
  assertPlainMetadata,
  createAgentAdapter,
  createCacheAdapter,
  fetch,
  isImageURI,
  resolveURI,
} from '../utils';

export default class URI {
  async getMetadata(uri: string, options?: AvatarResolverOpts) {
    if (options?.cache && options?.cache > 0) {
      createCacheAdapter(fetch, options?.cache);
    }
    if (options?.agents) {
      createAgentAdapter(fetch, options?.agents);
    }

    // bound the record before resolveURI validates/decodes it
    assertMetadataSize(uri);
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
    const response = await fetch(
      encodeURI(resolvedURI),
      METADATA_REQUEST_LIMITS
    );
    const metadata = await response?.data;
    assertPlainMetadata(metadata);
    return metadata;
  }
}
