import axios, { AxiosError } from 'axios';
import { Buffer } from 'buffer/';

import { fetch } from './fetch';

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
  'FFD8FF': 'image/jpeg',
  '89504E47': 'image/png',
  '47494638': 'image/gif',
  '424D': 'image/bmp',
  'FF0A': 'image/jxl',
};

const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300 MB

function isURIEncoded(uri: string): boolean {
  try {
    return uri !== decodeURIComponent(uri);
  } catch {
    return false;
  }
}

async function isStreamAnImage(url: string): Promise<boolean> {
  try {
    const source = axios.CancelToken.source();
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

    if (response.headers['content-length']) {
      const contentLength = parseInt(response.headers['content-length'], 10);
      if (contentLength > MAX_FILE_SIZE) {
        console.warn(`isStreamAnImage: File too large ${contentLength} bytes`);
        return false;
      }
    }

    let magicNumbers: string;
    // Check the binary signature (magic numbers) of the data
    if (response.data instanceof ArrayBuffer) {
      magicNumbers = new DataView(response.data).getUint32(0).toString(16);
    } else {
      if (
        !response.data ||
        typeof response.data === 'string' ||
        !('readUInt32BE' in response.data)
      ) {
        throw 'isStreamAnImage: unsupported data, instance is not BufferLike';
      }
      magicNumbers = response.data.readUInt32BE(0).toString(16);
    }

    const isBinaryImage = Object.keys(IMAGE_SIGNATURES).some(signature =>
      magicNumbers.toUpperCase().startsWith(signature)
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

export async function isImageURI(url: string): Promise<boolean> {
  const encodedURI = isURIEncoded(url) ? url : encodeURI(url);

  try {
    const result = await fetch({ url: encodedURI, method: 'HEAD' });

    if (result.status === 200) {
      const contentType = result.headers['content-type']?.toLowerCase();

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
        return isStreamAnImage(encodedURI);
      }

      return true;
    } else {
      console.warn(`isImageURI: HTTP error ${result.status}`);
      return false;
    }
  } catch (error) {
    if (error instanceof AxiosError) {
      console.warn('isImageURI: ', error.toString(), '-', error.config.url);
    } else {
      console.warn('isImageURI: ', error.toString());
    }

    // if error is not cors related then fail
    if (typeof error.response !== 'undefined') {
      // in case of cors, use image api to validate if given url is an actual image
      return false;
    }

    if (!globalThis.hasOwnProperty('Image')) {
      // fail in NodeJS, since the error is not cors but any other network issue
      return false;
    }

    return new Promise<boolean>(resolve => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = encodedURI;
    });
  }
}
