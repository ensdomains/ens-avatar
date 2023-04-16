import axios, { Axios } from 'axios';
import { Buffer } from 'buffer/';
import createDOMPurify from 'dompurify';
import { CID } from 'multiformats';
import isSVG from 'is-svg';
import urlJoin from 'url-join';

const IPFS_SUBPATH = '/ipfs/';
const IPNS_SUBPATH = '/ipns/';
const networkRegex = /(?<protocol>ipfs:\/|ipns:\/|ar:\/)?(?<root>\/)?(?<subpath>ipfs\/|ipns\/)?(?<target>[\w\-.]+)(?<subtarget>\/.*)?/;
const base64Regex = /^data:([a-zA-Z\-/+]*);base64,([^"].*)/;
const dataURIRegex = /^data:([a-zA-Z\-/+]*)?(;[a-zA-Z0-9].*?)?(,)/;

export interface BaseError {}
export class BaseError extends Error {
  __proto__: Error;
  constructor(message?: string) {
    const trueProto = new.target.prototype;
    super(message);

    this.__proto__ = trueProto;
  }
}

// simple assert without nested check
export function assert(condition: any, message: string) {
  if (!condition) {
    throw message;
  }
}

export async function handleSettled(promises: Promise<any>[]) {
  const values = [];
  const results = await Promise.allSettled(promises);
  for (let result of results) {
    if (result.status === 'fulfilled') values.push(result.value);
    else if (result.status === 'rejected') values.push(null);
  }
  return values;
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

export function isImageURI(url: string) {
  return new Promise(resolve => {
    fetch({ url, method: 'HEAD' })
      .then(result => {
        if (result.status === 200) {
          // retrieve content type header to check if content is image
          const contentType = result.headers['content-type'];

          if (contentType?.startsWith('application/octet-stream')) {
            // if image served with generic mimetype, do additional check
            resolve(isStreamAnImage(url));
          }

          resolve(contentType?.startsWith('image/'));
        } else {
          resolve(false);
        }
      })
      .catch(error => {
        // if error is not cors related then fail
        if (typeof error.response !== 'undefined') {
          // in case of cors, use image api to validate if given url is an actual image
          resolve(false);
          return;
        }
        if (!globalThis.hasOwnProperty('Image')) {
          // fail in NodeJS, since the error is not cors but any other network issue
          resolve(false);
          return;
        }
        const img = new Image();
        img.onload = () => {
          resolve(true);
        };
        img.onerror = () => {
          resolve(false);
        };
        img.src = url;
      });
  });
}

async function isStreamAnImage(url: string) {
  try {
    const CancelToken = axios.CancelToken;
    const source = CancelToken.source();

    const response = await fetch.get(url, {
      responseType: 'arraybuffer',
      headers: {
        Range: 'bytes=0-1023', // Download only the first 1024 bytes
      },
      cancelToken: source.token,
      onDownloadProgress: progressEvent => {
        if (progressEvent.loaded > 1024) {
          // Cancel the request if more than 1024 bytes have been downloaded
          source.cancel('Aborted to prevent downloading the entire file.');
        }
      },
    });

    let magicNumbers: string;
    // Check the binary signature (magic numbers) of the data
    if (response.data instanceof ArrayBuffer) {
      magicNumbers = new DataView(response.data).getUint32(0).toString(16);
    } else {
      magicNumbers = response.data.readUInt32BE(0).toString(16);
    }

    const imageSignatures = [
      'ffd8ff', // JPEG
      '89504e47', // PNG
      '47494638', // GIF
      '49492a00', // TIFF (little endian)
      '4d4d002a', // TIFF (big endian)
      '424d', // BMP
    ];

    const isBinaryImage = imageSignatures.some(signature =>
      magicNumbers.startsWith(signature)
    );

    // Check for SVG image
    const chunkAsString = Buffer.from(response.data).toString();
    const isSvgImage = /<svg[\s\S]*?xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(
      chunkAsString
    );

    return isBinaryImage || isSvgImage;
  } catch (error) {
    if (axios.isCancel(error)) {
      console.error('Stream request was canceled:', (error as Error).message);
    } else {
      console.error('Error checking stream:', error);
    }
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
    const [eip_namespace, chainID] = reference.split(':');
    const [erc_namespace, contractAddress] = asset_namespace.split(':');

    assert(
      eip_namespace && eip_namespace.toLowerCase() === 'eip155',
      'Only EIP-155 is supported'
    );
    assert(chainID, 'chainID not found');
    assert(contractAddress, 'contractAddress not found');
    assert(erc_namespace, 'erc namespace not found');
    assert(tokenID, 'tokenID not found');

    return {
      chainID: Number(chainID),
      namespace: erc_namespace.toLowerCase(),
      contractAddress,
      tokenID,
    };
  } catch (error) {
    throw new NFTURIParsingError(`${error as string} - ${uri}`);
  }
}

type Gateways = {
  ipfs?: string;
  arweave?: string;
};

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
      "'customGateway' option will be depreciated soon, please use 'gateways: {ipfs: YOUR_IPFS_GATEWAY }' instead"
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

function _sanitize(data: string, jsDomWindow?: any): Buffer {
  let domWindow;
  try {
    domWindow = window;
  } catch {
    // if js process run under nodejs require jsdom window
    if (!jsDomWindow) {
      throw Error('In node environment JSDOM window is required');
    }
    domWindow = jsDomWindow;
  }
  const DOMPurify = createDOMPurify(domWindow as any);
  // purges malicious scripting from svg content
  const cleanDOM = DOMPurify.sanitize(data);
  return Buffer.from(cleanDOM);
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

export interface ImageURIOpts {
  metadata: any;
  customGateway?: string;
  gateways?: Gateways;
  jsdomWindow?: any;
}

export function getImageURI({
  metadata,
  customGateway,
  gateways,
  jsdomWindow,
}: ImageURIOpts) {
  // retrieves image uri from metadata, if image is onchain then convert to base64
  const { image, image_url, image_data } = metadata;

  const _image = image || image_url || image_data;
  assert(_image, 'Image is not available');
  const { uri: parsedURI } = resolveURI(_image, gateways, customGateway);

  if (isSVG(parsedURI) || isSVGDataUri(parsedURI)) {
    // svg - image_data
    const rawSVG = convertToRawSVG(parsedURI);
    if (!rawSVG) return null;

    const data = _sanitize(rawSVG, jsdomWindow);
    return `data:image/svg+xml;base64,${data.toString('base64')}`;
  }

  if (isImageDataUri(parsedURI) || parsedURI.startsWith('http')) {
    return parsedURI;
  }

  return null;
}

function isImageDataUri(uri: string): boolean {
  const imageFormats = ['jpeg', 'png', 'gif', 'bmp', 'webp'];
  const dataUriPattern = /^data:image\/([a-zA-Z0-9]+)(?:;base64)?,/;

  const match = uri.match(dataUriPattern);
  if (!match || match.length < 2) {
    return false;
  }

  const format = match[1].toLowerCase();
  return imageFormats.includes(format);
}

function isSVGDataUri(uri: string): boolean {
  const svgDataUriPrefix = 'data:image/svg+xml';
  return uri.startsWith(svgDataUriPrefix);
}

export function convertToRawSVG(input: string): string | null {
  const base64Prefix = 'data:image/svg+xml;base64,';
  const encodedPrefix = 'data:image/svg+xml,';

  if (input.startsWith(base64Prefix)) {
    const base64Data = input.substring(base64Prefix.length);
    try {
      return Buffer.from(base64Data, 'base64').toString();
    } catch (error) {
      console.error('Invalid base64 encoded SVG');
      return null;
    }
  } else if (input.startsWith(encodedPrefix)) {
    const encodedData = input.substring(encodedPrefix.length);
    try {
      return decodeURIComponent(encodedData);
    } catch (error) {
      console.error('Invalid URL encoded SVG');
      return null;
    }
  } else {
    // The input is already a raw SVG (or another format if not used with isSVGDataUri)
    return input;
  }
}

export function createCacheAdapter(fetch: Axios, ttl: number) {
  // creates cache adapter for axios
  const { setupCache } = require('axios-cache-interceptor');
  setupCache(fetch, {
    ttl: ttl * 1000,
  });
}

function createFetcher({ ttl }: { ttl?: number }) {
  const _fetch = axios.create({ proxy: false });
  if (ttl && ttl > 0) {
    createCacheAdapter(_fetch, ttl);
  }
  return _fetch;
}

export const fetch = createFetcher({});
