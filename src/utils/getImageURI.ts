import { ImageURIOpts } from '../types';
import { assert } from './assert';
import { base64ToUtf8, utf8ToBase64 } from './base64';
import { isHostDenied } from './isHostDenied';
import { isValidBase64DataURI, resolveURI } from './resolveURI';
import { sanitizeSVG } from './sanitize';
import { toHttpURL } from './url';

function isSVGString(str: string): boolean {
  const trimmed = str.trimStart();
  return trimmed.startsWith('<svg') || trimmed.startsWith('<?xml');
}

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
      return base64ToUtf8(base64Data);
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

/**
 * Upper bound on an inline / data: SVG (in UTF-16 code units, before
 * sanitizing). On-chain SVGs are far smaller; this caps the CPU an attacker
 * controlling a record or CCIP gateway can make us spend.
 */
export const MAX_INLINE_SVG_LENGTH = 2 * 1024 * 1024;

const isWhitespace = (c: string) => /\s/.test(c);

/**
 * Remove whitespace around tags, i.e. `str.replace(/\s*(<[^>]+>)\s*\/g, '$1')`,
 * in linear time. The regex form is quadratic: every unterminated `<` rescans
 * to the end of the input, so ~1 MiB of `<` took tens of minutes.
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

/**
 * Keep only the root <svg> element of sanitized output. sanitize-html keeps
 * text nodes outside the root (e.g. `<?xml?>GIF89a<svg>…` → `GIF89a<svg>…`),
 * which makes the document invalid and lets its first bytes be sniffed as
 * another format. Returns null when there is no root <svg>.
 */
function extractSVGRoot(svg: string): string | null {
  const start = svg.search(/<svg[\s>]/);
  const end = svg.lastIndexOf('</svg>');
  if (start === -1 || end < start) return null;
  return svg.slice(start, end + '</svg>'.length);
}

function _sanitize(data: string): string | null {
  return extractSVGRoot(sanitizeSVG(data));
}

export function getImageURI({
  metadata,
  customGateway,
  gateways,
  urlDenyList,
}: ImageURIOpts) {
  // retrieves image uri from metadata, if image is onchain then convert to base64
  const { image, image_url, image_data } = metadata;

  const _image = image || image_url || image_data;
  assert(_image, 'Image is not available');
  const { uri: parsedURI } = resolveURI(
    _image as string,
    gateways,
    customGateway
  );

  if (isSVGString(parsedURI) || isSVGDataUri(parsedURI)) {
    // svg - image_data
    // The encoded form (base64, %XX) is at most 3x the decoded SVG.
    if (parsedURI.length > MAX_INLINE_SVG_LENGTH * 3) return null;
    const decoded = convertToRawSVG(parsedURI);
    if (!decoded || decoded.length > MAX_INLINE_SVG_LENGTH) return null;
    const rawSVG = collapseTagWhitespace(decoded);

    try {
      const cleanSVG = _sanitize(rawSVG);
      if (!cleanSVG) return null;
      return `data:image/svg+xml;base64,${utf8ToBase64(cleanSVG)}`;
    } catch (error) {
      console.error('SVG sanitization failed:', error);
      return null;
    }
  }

  // resolveURI only strips the first `data:…,` prefix, so a nested URI
  // (`data:,data:image/png;base64,…`) arrives here unchecked: validate it.
  if (isImageDataUri(parsedURI)) {
    return isValidBase64DataURI(parsedURI) ? parsedURI : null;
  }

  // Return the parsed form, so the URL callers check is the one they use.
  const url = toHttpURL(parsedURI);
  if (url) {
    if (isHostDenied(url, urlDenyList)) return null;
    return url;
  }

  return null;
}
