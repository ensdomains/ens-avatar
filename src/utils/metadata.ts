import { Buffer } from 'buffer/';

/** Maximum size of NFT metadata JSON, in bytes (decoded for data: URIs). */
export const MAX_METADATA_BYTES = 1_000_000;
/** Maximum number of top-level properties in NFT metadata. */
export const MAX_METADATA_PROPERTIES = 1000;
/**
 * Gas limit for the tokenURI() / uri() calls. Returning data costs memory
 * gas that grows quadratically with its size, so this bounds how large a
 * string a contract can return, while leaving room for on-chain art that
 * builds its metadata in the call.
 */
export const METADATA_CALL_GAS_LIMIT = 10_000_000;

/** Reject oversized encoded/decoded metadata BEFORE decoding or parsing it. */
export function assertMetadataSize(raw: string): void {
  // byte length, not character length — multibyte-safe
  if (Buffer.byteLength(raw, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error('NFT metadata exceeds maximum allowed size');
  }
}

/**
 * Reject metadata that is not a plain JSON object (a string, number, boolean,
 * null or array would be spread into the result index by index), or that has
 * too many properties, BEFORE spreading it. Stops counting at the limit, so an
 * oversized object is rejected without enumerating all of it.
 */
export function assertPlainMetadata(
  value: unknown
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NFT metadata must be a JSON object');
  }
  let count = 0;
  for (const key in value as Record<string, unknown>) {
    const own = Object.prototype.hasOwnProperty.call(value, key);
    if (own && ++count > MAX_METADATA_PROPERTIES) {
      throw new Error('NFT metadata exceeds the maximum number of properties');
    }
  }
}

/**
 * Parse on-chain metadata from a resolved `data:application/json` URI:
 * base64 when `isEncoded`, otherwise JSON text with the `data:` prefix
 * already stripped. Size is checked before decoding and before parsing, and
 * the shape before returning.
 */
export function parseOnChainMetadata(
  resolvedURI: string,
  isEncoded: boolean
): Record<string, unknown> {
  let json = resolvedURI;
  if (isEncoded) {
    const b64 = resolvedURI.replace('data:application/json;base64,', '');
    assertMetadataSize(b64); // bound before decode
    json = Buffer.from(b64, 'base64').toString();
  }
  assertMetadataSize(json); // bound decoded JSON bytes
  const metadata = JSON.parse(json);
  assertPlainMetadata(metadata);
  return metadata;
}

/** Request options that cap an HTTP metadata response. */
export const METADATA_REQUEST_LIMITS = {
  maxContentLength: MAX_METADATA_BYTES,
  maxBodyLength: MAX_METADATA_BYTES,
};
