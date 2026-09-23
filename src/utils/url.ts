/**
 * Parse an http(s) URL once and return its canonical form (`URL#href`), or
 * null for anything else.
 *
 * Checks and fetches must use this same string. Encoding the raw input
 * separately (e.g. with `encodeURI`) can move the host: for
 * `http://127.0.0.1\@attacker.example/a.png` the raw URL targets 127.0.0.1,
 * while its `encodeURI` form targets attacker.example.
 */
export function toHttpURL(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}
