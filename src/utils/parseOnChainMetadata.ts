import { base64ToUtf8 } from './base64';
import { MetadataParsingError } from './error';
import { DEFAULT_MAX_CONTENT_LENGTH } from './fetch';
import { parseJSON } from './json';

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

/** UTF-8 byte length of a string, without encoding it. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair: one 4-byte character
      i++;
    } else bytes += 3;
  }
  return bytes;
}

// Room for the "data:<mime>[;params][;base64]," header.
const DATA_URI_HEADER_ALLOWANCE = 256;

/**
 * Throw if an inline `data:` URI would decode to more than `maxBytes`.
 * Checked on the raw record/token URI, before resolveURI validates (decodes
 * and re-encodes) it.
 */
export function assertDataURISize(
  uri: string,
  maxBytes: number = DEFAULT_MAX_CONTENT_LENGTH
): void {
  if (!/^data:/i.test(uri)) return;
  const comma = uri.indexOf(',');
  const isBase64 = /;base64$/i.test(uri.slice(0, comma));
  const tooBig = isBase64
    ? uri.length > Math.ceil((maxBytes * 4) / 3) + DATA_URI_HEADER_ALLOWANCE
    : // percent-encoding can triple the bytes; parseOnChainMetadata then
      // checks the exact size of the JSON itself
      utf8ByteLength(uri) > maxBytes * 3 + DATA_URI_HEADER_ALLOWANCE;
  if (tooBig) {
    throw new MetadataParsingError(`Inline metadata exceeds ${maxBytes} bytes`);
  }
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
  // base64 is 4/3 the size of the bytes it encodes; raw JSON is counted in
  // UTF-8 bytes, like a fetched body.
  const tooBig = isEncoded
    ? resolvedURI.length > Math.ceil((maxBytes * 4) / 3) + 64
    : utf8ByteLength(resolvedURI) > maxBytes;
  if (tooBig) {
    throw new MetadataParsingError(`Token metadata exceeds ${maxBytes} bytes`);
  }
  let parsed: unknown;
  try {
    const json = isEncoded
      ? base64ToUtf8(resolvedURI.replace('data:application/json;base64,', ''))
      : resolvedURI;
    parsed = parseJSON(json);
  } catch (e) {
    throw new MetadataParsingError(
      `Failed to parse token metadata: ${(e as Error).message}`
    );
  }
  return asMetadataObject(parsed);
}
