/** Longest valid DNS name (RFC 1035), excluding a trailing dot. */
export const MAX_HOSTNAME_LENGTH = 253;

/**
 * Canonical form of a hostname for comparisons: lowercase, no IPv6 brackets,
 * no trailing dots. `metadata.ens.domains.` resolves to the same host as
 * `metadata.ens.domains` (and `127.0.0.1..` / `localhost.` to loopback), but
 * the URL parser keeps the dots, so raw comparisons can be bypassed with them.
 */
export function normalizeHostname(hostname: string): string {
  const h = hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  // Backward scan: `/\.+$/` is quadratic on long runs of dots.
  let end = h.length;
  while (end > 0 && h[end - 1] === '.') end--;
  return h.slice(0, end);
}

/** True if a normalized hostname is too long to be a real DNS name. */
export function isOverlongHostname(normalized: string): boolean {
  return normalized.length > MAX_HOSTNAME_LENGTH;
}

/**
 * True if `hostname` equals a deny-list entry or is a subdomain of one.
 * Overlong hostnames count as denied (fail closed).
 */
export function hostMatchesDenyList(
  hostname: string,
  denyList: string[]
): boolean {
  const host = normalizeHostname(hostname);
  if (isOverlongHostname(host)) return true;
  return denyList.some(entry => {
    const denied = normalizeHostname(entry);
    return !!denied && (host === denied || host.endsWith('.' + denied));
  });
}
