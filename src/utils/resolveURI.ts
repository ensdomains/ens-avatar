import { Gateways } from '../types';
import { base64ToBytes, bytesToBase64 } from './base64';
import { isCID } from './isCID';
import { detectImageMimeType } from './sniffImage';

const IPFS_SUBPATH = '/ipfs/';
const IPNS_SUBPATH = '/ipns/';
const networkRegex = /(?<protocol>ipfs:\/|ipns:\/|ar:\/)?(?<root>\/)?(?<subpath>ipfs\/|ipns\/)?(?<target>[\w\-.]+)(?<subtarget>\/.*)?/;
const base64Regex = /^data:([a-zA-Z\-/+]*);base64,([^"].*)/;
const dataURIRegex = /^data:([a-zA-Z\-/+]*)?(;[a-zA-Z0-9].*?)?(,)/;
const JSON_MIMETYPE = 'data:application/json;';

function _getImageMimeType(uri: string) {
  const base64Data = uri.replace(base64Regex, '$2');
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64Data);
  } catch {
    return null; // not valid base64
  }

  if (bytes.length < 12) {
    return null; // not enough data to determine the type
  }

  const mimeType = detectImageMimeType(bytes);
  if (mimeType) return mimeType;
  // "<svg" — base64 SVG data URIs
  if (String.fromCharCode(...Array.from(bytes.subarray(0, 4))) === '<svg') {
    return 'image/svg+xml';
  }
  return null;
}

/**
 * True for a well-formed base64 data URI: a JSON document, or an image whose
 * bytes match the MIME type in its header.
 */
export function isValidBase64DataURI(uri: string) {
  if (typeof uri !== 'string') {
    return false;
  }

  // check if the string matches the Base64 pattern
  if (!base64Regex.test(uri)) {
    return false;
  }

  const [header, str] = uri.split('base64,');
  if (header != JSON_MIMETYPE) {
    const mimeType = _getImageMimeType(uri);
    if (!mimeType || !header.includes(mimeType)) {
      return false;
    }
  }

  // length must be multiple of 4
  if (str.length % 4 !== 0) {
    return false;
  }

  try {
    // try to encode/decode the string, to see if matches
    const encoded = bytesToBase64(base64ToBytes(str));
    return encoded === str;
  } catch (e) {
    return false;
  }
}

const trimSlashes = (part: string, leading: boolean, trailing: boolean) => {
  let start = 0;
  let end = part.length;
  if (leading) while (start < end && part[start] === '/') start++;
  if (trailing) while (end > start && part[end - 1] === '/') end--;
  return part.slice(start, end);
};

/**
 * Join URL parts with single slashes, like url-join (which this replaces):
 * url-join's /[\/]+$/ is quadratic on runs of slashes inside a part, and
 * the parts here (IPFS/Arweave paths) come from records.
 */
function joinURL(...parts: string[]): string {
  const last = parts.length - 1;
  const joined = parts
    .map((part, i) => {
      const trimmed = trimSlashes(part, i > 0, true);
      // keep one trailing slash on the last part, as url-join does
      return i === last && part.endsWith('/') && trimmed
        ? trimmed + '/'
        : trimmed;
    })
    .filter(Boolean)
    .join('/');
  // drop a slash before a query or fragment
  return joined.replace(/\/(\?|#)/g, '$1');
}

function _replaceGateway(uri: string, source: string, target?: string) {
  if (uri.startsWith(source) && target) {
    try {
      let _uri = new URL(uri);
      _uri.hostname = new URL(target).hostname;
      return _uri.toString();
    } catch (_error) {
      return uri;
    }
  }
  return uri;
}

export function resolveURI(
  uri: string,
  gateways?: Gateways,
  customGateway?: string
): { uri: string; isOnChain: boolean; isEncoded: boolean } {
  // resolves uri based on its' protocol
  const isEncoded = isValidBase64DataURI(uri);
  if (isEncoded || uri.startsWith('http')) {
    uri = _replaceGateway(uri, 'https://ipfs.io/', gateways?.ipfs);
    uri = _replaceGateway(uri, 'https://arweave.net/', gateways?.arweave);
    return { uri, isOnChain: isEncoded, isEncoded };
  }

  // customGateway option will be depreciated after 2 more version bump
  if (!gateways?.ipfs && !!customGateway) {
    console.warn(
      "'customGateway' option depreciated, please use 'gateways: {ipfs: YOUR_IPFS_GATEWAY }' instead"
    );
    gateways = { ...gateways, ipfs: customGateway };
  }

  const ipfsGateway = gateways?.ipfs || 'https://ipfs.io';
  const arGateway = gateways?.arweave || 'https://arweave.net';
  const networkRegexResult = uri.match(networkRegex);
  const { protocol, subpath, target, subtarget = '' } =
    networkRegexResult?.groups || {};
  if ((protocol === 'ipns:/' || subpath === 'ipns/') && target) {
    return {
      uri: joinURL(ipfsGateway, IPNS_SUBPATH, target, subtarget),
      isOnChain: false,
      isEncoded: false,
    };
  } else if (isCID(target)) {
    // Assume that it's a regular IPFS CID and not an IPNS key
    return {
      uri: joinURL(ipfsGateway, IPFS_SUBPATH, target, subtarget),
      isOnChain: false,
      isEncoded: false,
    };
  } else if (protocol === 'ar:/' && target) {
    return {
      uri: joinURL(arGateway, target, subtarget || ''),
      isOnChain: false,
      isEncoded: false,
    };
  } else {
    // we may want to throw error here
    return {
      uri: uri.replace(dataURIRegex, ''),
      isOnChain: true,
      isEncoded: false,
    };
  }
}
