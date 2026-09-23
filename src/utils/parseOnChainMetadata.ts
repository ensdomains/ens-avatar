import { base64ToUtf8 } from './base64';
import { MetadataParsingError } from './error';

/**
 * Parse inline JSON metadata, as returned by `resolveURI` for an on-chain
 * `data:application/json` URI: base64 when `isEncoded`, otherwise the JSON
 * text with its `data:` prefix already stripped.
 */
export function parseOnChainMetadata(
  resolvedURI: string,
  isEncoded: boolean
): Record<string, unknown> {
  try {
    const json = isEncoded
      ? base64ToUtf8(resolvedURI.replace('data:application/json;base64,', ''))
      : resolvedURI;
    return JSON.parse(json);
  } catch (e) {
    throw new MetadataParsingError(
      `Failed to parse token metadata: ${(e as Error).message}`
    );
  }
}
