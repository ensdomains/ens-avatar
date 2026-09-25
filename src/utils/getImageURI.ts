import createDOMPurify from 'dompurify';
import isSVG from 'is-svg';

import { ImageURIOpts } from '../types';
import { assert } from './assert';
import { resolveURI } from './resolveURI';

function isSVGDataUri(uri: string): boolean {
  const svgDataUriPrefix = 'data:image/svg+xml';
  return uri.startsWith(svgDataUriPrefix);
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

  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'meta') {
      if (node.getAttribute('http-equiv') === 'refresh') {
        node.remove();
      }
    }
  });

  // purges malicious scripting from svg content
  const cleanDOM = DOMPurify.sanitize(data, {
    FORBID_TAGS: ['a', 'area', 'base', 'iframe', 'link'],
  });
  return Buffer.from(cleanDOM);
}

const isWhitespace = (c: string) => /\s/.test(c);

/**
 * Remove whitespace around tags — the same output as
 * `str.replace(/\s*(<[^>]+>)\s*\/g, '$1')`, in linear time. That regex is
 * quadratic: a long whitespace run not followed by a tag, or a run of
 * unterminated `<`, is rescanned from every position (80k spaces took ~10 s).
 */
export function collapseTagWhitespace(str: string): string {
  let out = '';
  let i = 0;
  while (i < str.length) {
    const open = str.indexOf('<', i);
    if (open === -1) break;
    const close = str.indexOf('>', open + 1);
    // No '>' after this '<' means no complete tag remains anywhere after it.
    if (close === -1) break;
    if (close === open + 1) {
      // '<>' is not a tag (the regex needs at least one char between).
      out += str.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    let textEnd = open;
    while (textEnd > i && isWhitespace(str[textEnd - 1])) textEnd--;
    out += str.slice(i, textEnd) + str.slice(open, close + 1);
    i = close + 1;
    while (i < str.length && isWhitespace(str[i])) i++;
  }
  return out + str.slice(i);
}

export function getImageURI({
  metadata,
  customGateway,
  gateways,
  jsdomWindow,
  urlDenyList,
}: ImageURIOpts) {
  // retrieves image uri from metadata, if image is onchain then convert to base64
  const { image, image_url, image_data } = metadata;

  const _image = image || image_url || image_data;
  assert(_image, 'Image is not available');
  const { uri: parsedURI } = resolveURI(_image, gateways, customGateway);

  if (isSVG(parsedURI) || isSVGDataUri(parsedURI)) {
    // svg - image_data
    const decoded = convertToRawSVG(parsedURI);
    const rawSVG = decoded && collapseTagWhitespace(decoded);
    if (!rawSVG) return null;

    const data = _sanitize(rawSVG, jsdomWindow);
    return `data:image/svg+xml;base64,${data.toString('base64')}`;
  }

  if (isImageDataUri(parsedURI) || parsedURI.startsWith('http')) {
    if (urlDenyList?.includes(new URL(parsedURI).hostname)) return null;
    return parsedURI;
  }

  return null;
}
