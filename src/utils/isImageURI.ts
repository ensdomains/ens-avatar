import { Fetcher } from '../types';
import { fetch as defaultFetch } from './fetch';

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

export const IMAGE_SIGNATURES = {
  FFD8FF: 'image/jpeg',
  '89504E47': 'image/png',
  '47494638': 'image/gif',
  '424D': 'image/bmp',
  FF0A: 'image/jxl',
};

const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300 MB

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

    if (response.headers['content-length']) {
      const contentLength = parseInt(response.headers['content-length'], 10);
      if (contentLength > MAX_FILE_SIZE) {
        console.warn(`isStreamAnImage: File too large ${contentLength} bytes`);
        return false;
      }
    }

    // Check the binary signature (magic numbers) of the data
    const magicNumbers = new DataView(response.data).getUint32(0).toString(16);

    const isBinaryImage = Object.keys(IMAGE_SIGNATURES).some(signature =>
      magicNumbers.toUpperCase().startsWith(signature)
    );

    // Check for SVG image - must start with <svg or <?xml (after stripping whitespace/BOM)
    const chunkAsString = new TextDecoder()
      .decode(response.data)
      .replace(/^\uFEFF/, '')
      .trimStart();
    const isSvgImage = /^<(?:svg[\s>]|\?xml\s)/.test(chunkAsString);

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
  const encodedURI = isURIEncoded(url) ? url : encodeURI(url);
  const _fetcher = fetcher || defaultFetch;

  try {
    const result = await _fetcher.head(encodedURI);

    if (result.status === 200) {
      const contentType = result.headers['content-type']
        ?.toLowerCase()
        .split(';')[0]
        .trim();

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
        return isStreamAnImage(encodedURI, _fetcher);
      }

      return true;
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
      img.src = encodedURI;
    });
  }
}
