import urlJoin from 'url-join';

import { Gateways } from '../types';
import { isCID } from './isCID';

const IPFS_SUBPATH = '/ipfs/';
const IPNS_SUBPATH = '/ipns/';
const networkRegex = /(?<protocol>ipfs:\/|ipns:\/|ar:\/)?(?<root>\/)?(?<subpath>ipfs\/|ipns\/)?(?<target>[\w\-.]+)(?<subtarget>\/.*)?/;
const base64Regex = /^data:([a-zA-Z\-/+]*);base64,([^"].*)/;
const dataURIRegex = /^data:([a-zA-Z\-/+]*)?(;[a-zA-Z0-9].*?)?(,)/;

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
  const isEncoded = base64Regex.test(uri);
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
