/**
 * Canonical form of a hostname for comparisons: lowercase, no IPv6 brackets,
 * no trailing dots. `metadata.ens.domains.` resolves to the same host as
 * `metadata.ens.domains` (and `127.0.0.1..` / `localhost.` to loopback), but
 * the URL parser keeps the dots, so raw comparisons can be bypassed with them.
 */
export function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, '');
}

/** True if `hostname` equals a deny-list entry or is a subdomain of one. */
export function hostMatchesDenyList(
  hostname: string,
  denyList: string[]
): boolean {
  const host = normalizeHostname(hostname);
  return denyList.some(entry => {
    const denied = normalizeHostname(entry);
    return !!denied && (host === denied || host.endsWith('.' + denied));
  });
}
