import { fetch, resolveURI } from '../utils';

export default class URI {
  async getMetadata(uri: string) {
    const resolvedURI = resolveURI(uri);
    const response = await fetch(resolvedURI);
    const contentType = response.headers['content-type'];
    if (contentType.startsWith('image/')) {
      return { image: uri, uri };
    }
    return await response?.data;
  }
}
