/**
 * Identify a raster image format from its first bytes (magic numbers).
 * Needs at most the first 16 bytes. Returns the MIME type, or null when the
 * bytes are not a recognised image format.
 */

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...Array.from(bytes.subarray(start, end)));

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  bytes.length >= signature.length &&
  signature.every((byte, i) => bytes[i] === byte);

// ISO-BMFF (`....ftyp<brand>`) brands for AVIF and HEIF/HEIC.
const FTYP_BRANDS: Record<string, string> = {
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  heim: 'image/heif',
  heis: 'image/heif',
  mif1: 'image/heif',
  msf1: 'image/heif',
};

export function detectImageMimeType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    return 'image/gif';
  }
  if (ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii(bytes, 4, 8) === 'ftyp') {
    return FTYP_BRANDS[ascii(bytes, 8, 12)] ?? null;
  }
  // JPEG XL: bare codestream, or the ISOBMFF-style container.
  if (startsWith(bytes, [0xff, 0x0a])) return 'image/jxl';
  if (
    startsWith(bytes, [
      0,
      0,
      0,
      0x0c,
      0x4a,
      0x58,
      0x4c,
      0x20,
      0x0d,
      0x0a,
      0x87,
      0x0a,
    ])
  ) {
    return 'image/jxl';
  }
  return null;
}
