import { fetch, resolveURI } from '../utils';

export default class URI {
  async getMetadata(uri: string) {
    const { uri: resolvedURI, isOnChain } = resolveURI(uri);
    if (isOnChain) {
      return resolvedURI;
    }
    const response = await fetch(resolvedURI);
    const contentType = response.headers['content-type'];
    if (contentType.startsWith('image/')) {
      return { image: uri };
    }
    return await response?.data;
  }
}
