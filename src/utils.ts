import { strict as assert } from 'assert';
import axios from 'axios';
import createDOMPurify from 'dompurify';
import { CID } from 'multiformats/cid';
import isSVG from 'is-svg';
import urlJoin from 'url-join';

let domWindow = window;
if (!domWindow) {
  // if js process run under nodejs require jsdom
  const { JSDOM } = require('jsdom');
  domWindow = new JSDOM('').window;
}
const DOMPurify = createDOMPurify(domWindow as any);

const IPFS_SUBPATH = '/ipfs/';
const IPNS_SUBPATH = '/ipns/';
const ipfsRegex = /(?<protocol>ipfs:\/|ipns:\/)?(?<root>\/)?(?<subpath>ipfs\/|ipns\/)?(?<target>[\w-.]+)(?<subtarget>\/.*)?/;

export interface BaseError {}
export class BaseError extends Error {
  __proto__: Error;
  constructor(message?: string) {
    const trueProto = new.target.prototype;
    super(message);

    this.__proto__ = trueProto;
  }
}

export interface NFTURIParsingError {}
export class NFTURIParsingError extends BaseError {}

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

export function parseNFT(uri: string, seperator: string = '/') {
  // parse valid nft spec (CAIP-22/CAIP-29)
  // @see: https://github.com/ChainAgnostic/CAIPs/tree/master/CAIPs
  try {
    assert(uri, 'parameter URI cannot be empty');

    if (uri.startsWith('did:nft:')) {
      // convert DID to CAIP
      uri = uri.replace('did:nft:', '').replace(/_/g, '/');
    }

    const [reference, asset_namespace, tokenID] = uri.split(seperator);
    const [, chainID] = reference.split(':');
    const [namespace, contractAddress] = asset_namespace.split(':');

    assert(chainID, 'chainID not found');
    assert(contractAddress, 'contractAddress not found');
    assert(namespace, 'namespace not found');
    assert(tokenID, 'tokenID not found');

    return {
      chainID: Number(chainID),
      namespace: namespace.toLowerCase(),
      contractAddress,
      tokenID,
    };
  } catch (error) {
    throw new NFTURIParsingError(`${(error as Error).message} - ${uri}`);
  }
}

export function resolveURI(uri: string, customGateway?: string): string {
  // resolves uri based on its' protocol
  if (uri.startsWith('data:') || uri.startsWith('http')) {
    return uri;
  }

  const ipfsGateway = customGateway || 'https://ipfs.io';
  const ipfsRegexpResult = uri.match(ipfsRegex);
  const { protocol, subpath, target, subtarget = '' } =
    ipfsRegexpResult?.groups || {};
  if ((protocol === 'ipns:/' || subpath === 'ipns/') && target) {
    return urlJoin(ipfsGateway, IPNS_SUBPATH, target, subtarget);
  } else if (isCID(target)) {
    // Assume that it's a regular IPFS CID and not an IPNS key
    return urlJoin(ipfsGateway, IPFS_SUBPATH, target, subtarget);
  } else {
    // we may want to throw error here
    return uri;
  }
}

function _sanitize(data: string): Buffer {
  // purges malicious scripting from svg content
  const cleanDOM = DOMPurify.sanitize(data);
  return Buffer.from(cleanDOM);
}

export function getImageURI(meta: any, customGateway?: string) {
  // retrieves image uri from metadata, if image is onchain then convert to base64
  const { image, image_url, image_data } = meta;

  const _image = image || image_url || image_data;
  assert(_image, 'Image is not available');
  const parsedURI = resolveURI(_image, customGateway);

  if (parsedURI.startsWith('data:') || parsedURI.startsWith('http')) {
    return parsedURI;
  }

  if (isSVG(parsedURI)) {
    // svg - image_data
    const data = _sanitize(parsedURI);
    return data.toString('base64');
  }
  return null;
}

export function createCacheAdapter(ttl: number) {
  // creates cache adapter for axios
  const { setupCache } = require('axios-cache-adapter');
  const cache = setupCache({
    maxAge: ttl * 1000,
  });
  return cache.adapter;
}

function createFetcher({ ttl }: { ttl?: number }) {
  let options = {};
  if (ttl && ttl > 0) {
    options = {
      adapter: createCacheAdapter(ttl),
    };
  }
  return axios.create(options);
}

export const fetch = createFetcher({});
