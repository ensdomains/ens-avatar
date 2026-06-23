import { ImageURIOpts } from '../types';
import { assert } from './assert';
import { base64ToUtf8, utf8ToBase64 } from './base64';
import { isHostDenied } from './isHostDenied';
import { resolveURI } from './resolveURI';
import { sanitizeSVG } from './sanitize';

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

function _sanitize(data: string): string {
  return sanitizeSVG(data);
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
    const rawSVG = convertToRawSVG(parsedURI)?.replace(
      /\s*(<[^>]+>)\s*/g,
      '$1'
    );
    if (!rawSVG) return null;

    try {
      const cleanSVG = _sanitize(rawSVG);
      return `data:image/svg+xml;base64,${utf8ToBase64(cleanSVG)}`;
    } catch (error) {
      console.error('SVG sanitization failed:', error);
      return null;
    }
  }

  if (isImageDataUri(parsedURI) || parsedURI.startsWith('http')) {
    if (isHostDenied(parsedURI, urlDenyList)) return null;
    return parsedURI;
  }

  return null;
}
