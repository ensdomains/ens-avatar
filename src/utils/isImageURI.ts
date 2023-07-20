import axios from 'axios';
import { Buffer } from 'buffer/';

import { fetch } from './fetch';

async function isStreamAnImage(url: string) {
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
        console.warn('isImageURI: fetch error', error);
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
