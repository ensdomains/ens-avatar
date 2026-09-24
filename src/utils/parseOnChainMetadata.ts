import { base64ToUtf8 } from './base64';
import { MetadataParsingError } from './error';
import { DEFAULT_MAX_CONTENT_LENGTH } from './fetch';

/**
 * Metadata must be a JSON object. Anything else (an array, a number, a string)
 * would be spread into the result index by index / character by character.
 */
export function asMetadataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MetadataParsingError('Token metadata is not a JSON object');
  }
  // JSON.parse makes "__proto__" an own key; a consumer copying the result
  // with Object.assign would turn it into the prototype (and inherit its
  // fields). Drop it.
  const metadata: Record<string, unknown> = { ...value };
  delete metadata['__proto__'];
  return metadata;
}

/**
 * Parse inline JSON metadata, as returned by `resolveURI` for an on-chain
 * `data:application/json` URI: base64 when `isEncoded`, otherwise the JSON
 * text with its `data:` prefix already stripped. Inline JSON gets the same
 * size cap as fetched JSON (`maxContentLength`), checked before decoding.
 */
export function parseOnChainMetadata(
  resolvedURI: string,
  isEncoded: boolean,
  maxBytes: number = DEFAULT_MAX_CONTENT_LENGTH
): Record<string, unknown> {
  // base64 is 4/3 the size of the bytes it encodes
  const limit = isEncoded ? Math.ceil((maxBytes * 4) / 3) + 64 : maxBytes;
  if (resolvedURI.length > limit) {
    throw new MetadataParsingError(`Token metadata exceeds ${maxBytes} bytes`);
  }
  let parsed: unknown;
  try {
    const json = isEncoded
      ? base64ToUtf8(resolvedURI.replace('data:application/json;base64,', ''))
      : resolvedURI;
    parsed = JSON.parse(json);
  } catch (e) {
    throw new MetadataParsingError(
      `Failed to parse token metadata: ${(e as Error).message}`
    );
  }
  return asMetadataObject(parsed);
}
