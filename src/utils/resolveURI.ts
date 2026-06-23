import urlJoin from 'url-join';

import { Gateways } from '../types';
import { base64ToBytes, bytesToBase64, bytesToHex } from './base64';
import { isCID } from './isCID';
import { IMAGE_SIGNATURES } from './isImageURI';

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

  // get the hex representation of the first 12 bytes
  const hex = bytesToHex(bytes, 0, 12).toUpperCase();

  // check against magic number mapping
  for (const [magicNumber, mimeType] of Object.entries({
    ...IMAGE_SIGNATURES,
    '52494646': 'special_webp_check',
    '3C737667': 'image/svg+xml',
  })) {
    if (hex.startsWith(magicNumber.toUpperCase())) {
      if (mimeType === 'special_webp_check') {
        // RIFF (bytes 0-3) + size (4-7) + 'WEBP' (8-11). The 'WE' marker
        // (0x5745) is at bytes 8-9 → hex chars 16-19, not 8-11.
        return hex.slice(16, 20) === '5745' ? 'image/webp' : null;
      }
      return mimeType;
    }
  }

  return null;
}

function _isValidBase64(uri: string) {
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
  const isEncoded = _isValidBase64(uri);
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
      uri: urlJoin(ipfsGateway, IPNS_SUBPATH, target, subtarget),
      isOnChain: false,
      isEncoded: false,
    };
  } else if (isCID(target)) {
    // Assume that it's a regular IPFS CID and not an IPNS key
    return {
      uri: urlJoin(ipfsGateway, IPFS_SUBPATH, target, subtarget),
      isOnChain: false,
      isEncoded: false,
    };
  } else if (protocol === 'ar:/' && target) {
    return {
      uri: urlJoin(arGateway, target, subtarget || ''),
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
