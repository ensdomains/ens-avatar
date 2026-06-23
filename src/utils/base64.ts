/**
 * Runtime-agnostic base64 / UTF-8 / hex helpers.
 *
 * Implemented with WHATWG globals only (`atob`/`btoa`, `TextEncoder`/
 * `TextDecoder`), all of which exist in Node (>=16), browsers, and edge
 * runtimes (Cloudflare Workers). This lets the library handle on-chain base64
 * payloads identically everywhere with no `Buffer` polyfill — so there is no
 * `buffer` runtime dependency and the ESM build has no `import 'buffer/'`
 * directory specifier (which is unresolvable under native Node ESM).
 */

// Encode in chunks so very large SVG/metadata payloads don't exceed the
// argument-count limit of String.fromCharCode / the engine's call stack.
const CHUNK_SIZE = 0x8000;

/** Encode raw bytes to a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(
      null,
      (bytes.subarray(i, i + CHUNK_SIZE) as unknown) as number[]
    );
  }
  return btoa(binary);
}

/** Decode a base64 string to raw bytes. Throws on invalid base64. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode a UTF-8 string to base64. */
export function utf8ToBase64(str: string): string {
  return bytesToBase64(new TextEncoder().encode(str));
}

/** Decode a base64 string to a UTF-8 string. Throws on invalid base64. */
export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

/** Lowercase hex of the bytes in [start, end), e.g. for magic-number sniffing. */
export function bytesToHex(
  bytes: Uint8Array,
  start = 0,
  end: number = bytes.length
): string {
  let hex = '';
  const stop = Math.min(end, bytes.length);
  for (let i = start; i < stop; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
