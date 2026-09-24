import { base64ToUtf8 } from './base64';
import { MetadataParsingError } from './error';

/**
 * Metadata must be a JSON object. Anything else (an array, a number, a string)
 * would be spread into the result index by index / character by character.
 */
export function asMetadataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MetadataParsingError('Token metadata is not a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * Parse inline JSON metadata, as returned by `resolveURI` for an on-chain
 * `data:application/json` URI: base64 when `isEncoded`, otherwise the JSON
 * text with its `data:` prefix already stripped.
 */
export function parseOnChainMetadata(
  resolvedURI: string,
  isEncoded: boolean
): Record<string, unknown> {
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
