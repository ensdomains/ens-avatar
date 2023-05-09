import { CID } from 'multiformats';

export function isCID(hash: any) {
  // check if given string or object is a valid IPFS CID
  try {
    if (typeof hash === 'string') {
      return Boolean(CID.parse(hash));
    }

    return Boolean(CID.asCID(hash));
  } catch (_error) {
    return false;
  }
}
