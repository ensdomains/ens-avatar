import { CID } from 'multiformats';

// Real CIDs are well under 100 characters. CID.parse (base58/base32 decode)
// is quadratic in the input length, so longer strings are rejected up front.
const MAX_CID_LENGTH = 256;

export function isCID(hash: any) {
  // check if given string or object is a valid IPFS CID
  try {
    if (typeof hash === 'string') {
      if (hash.length > MAX_CID_LENGTH) return false;
      return Boolean(CID.parse(hash));
    }

    return Boolean(CID.asCID(hash));
  } catch (_error) {
    return false;
  }
}
