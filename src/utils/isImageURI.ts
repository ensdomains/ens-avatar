import { Fetcher } from '../types';
import { fetch as defaultFetch } from './fetch';
import { detectImageMimeType } from './sniffImage';
import { toHttpURL } from './url';

export const ALLOWED_IMAGE_MIMETYPES = [
  'application/octet-stream',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/jxl',
];

const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300 MB

// Non-standard names servers use for allowed types.
const MIME_TYPE_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-ms-bmp': 'image/bmp',
  'image/x-bmp': 'image/bmp',
};

// Status codes from hosts that refuse HEAD (405, 501) or sign URLs for GET
// only (S3 presigned URLs answer HEAD with 403): sniff with a ranged GET.
const HEAD_REFUSED_STATUSES = [403, 405, 501];

/**
 * True if `text` starts an SVG document: an XML prolog (declaration, other
 * processing instructions, comments, a doctype with an optional internal
 * subset, whitespace) followed by the <svg> root. A bare "<?xml" prefix would
 * also admit XHTML. Scans forward only, so it is linear in `text`.
 */
export function isSvgDocument(text: string): boolean {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    let end: number;
    if (text.startsWith('<?', i)) {
      end = text.indexOf('?>', i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      end = text.indexOf('-->', i + 4);
      if (end === -1) return false;
      i = end + 3;
    } else if (text.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') {
      end = text.indexOf('>', i);
      const subset = text.indexOf('[', i);
      if (subset !== -1 && (end === -1 || subset < end)) {
        const subsetEnd = text.indexOf(']', subset);
        if (subsetEnd === -1) return false;
        end = text.indexOf('>', subsetEnd);
      }
      if (end === -1) return false;
      i = end + 1;
    } else {
      return /^<svg[\s>/]/i.test(text.slice(i, i + 5));
    }
  }
}

export function isURIEncoded(uri: string): boolean {
  try {
    return uri !== decodeURIComponent(uri);
  } catch {
    return false;
  }
}

async function isStreamAnImage(
  url: string,
  fetcher: Fetcher
): Promise<boolean> {
  try {
    const response = await fetcher.getArrayBuffer(url, {
      headers: {
        Range: 'bytes=0-1023',
      },
    });

    if (response.status !== 200 && response.status !== 206) return false;

    if (response.headers['content-length']) {
      const contentLength = parseInt(response.headers['content-length'], 10);
      if (contentLength > MAX_FILE_SIZE) {
        console.warn(`isStreamAnImage: File too large ${contentLength} bytes`);
        return false;
      }
    }

    // Check the binary signature (magic numbers) of the data
    const isBinaryImage =
      detectImageMimeType(new Uint8Array(response.data)) !== null;

    // Check for SVG image - must start with <svg or <?xml (after stripping whitespace/BOM)
    const chunkAsString = new TextDecoder()
      .decode(response.data)
      .replace(/^\uFEFF/, '')
      .trimStart();
    const isSvgImage = isSvgDocument(chunkAsString);

    return isBinaryImage || isSvgImage;
  } catch (error) {
    if (
      error instanceof DOMException ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      console.error('Stream request was canceled:', (error as Error).message);
    } else {
      console.error('Error checking stream:', error);
    }
    return false;
  }
}

export async function isImageURI(
  url: string,
  fetcher?: Fetcher
): Promise<boolean> {
  const checkedURL = toHttpURL(url);
  if (!checkedURL) return false;
  const _fetcher = fetcher || defaultFetch;

  try {
    const result = await _fetcher.head(checkedURL);

    if (result.status === 200) {
      const rawType = result.headers['content-type']
        ?.toLowerCase()
        .split(';')[0]
        .trim();
      const contentType = rawType && (MIME_TYPE_ALIASES[rawType] ?? rawType);

      if (!contentType || !ALLOWED_IMAGE_MIMETYPES.includes(contentType)) {
        console.warn(`isImageURI: Invalid content type ${contentType}`);
        return false;
      }

      const contentLength = parseInt(
        result.headers['content-length'] || '0',
        10
      );
      if (contentLength > MAX_FILE_SIZE) {
        console.warn(`isImageURI: File too large ${contentLength} bytes`);
        return false;
      }

      if (contentType === 'application/octet-stream') {
        // if image served with generic mimetype, do additional check
        return isStreamAnImage(checkedURL, _fetcher);
      }

      return true;
    } else if (HEAD_REFUSED_STATUSES.includes(result.status)) {
      return isStreamAnImage(checkedURL, _fetcher);
    } else {
      console.warn(`isImageURI: HTTP error ${result.status}`);
      return false;
    }
  } catch (error) {
    console.warn('isImageURI: ', (error as any).toString());

    // Native fetch throws TypeError for network/CORS errors.
    // If error has a response property it's a non-CORS server error — fail.
    if (typeof (error as any).response !== 'undefined') {
      return false;
    }

    if (!globalThis.hasOwnProperty('Image')) {
      // fail in NodeJS, since the error is not cors but any other network issue
      return false;
    }

    return new Promise<boolean>(resolve => {
      const img = new Image();
      const timeout = setTimeout(() => {
        img.src = '';
        resolve(false);
      }, 10000);
      img.onload = () => {
        clearTimeout(timeout);
        img.src = '';
        resolve(true);
      };
      img.onerror = () => {
        clearTimeout(timeout);
        img.src = '';
        resolve(false);
      };
      img.src = checkedURL;
    });
  }
}
