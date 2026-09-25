import { parseIPv4, parseIPv6 } from './ip';

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
 * The forms a host can be compared in: its URL-canonical form (punycode for
 * IDNs, canonical IPv4/IPv6 text), plus — for an IPv4-mapped or NAT64 IPv6
 * address — the IPv4 address it embeds.
 */
function hostForms(host: string): string[] {
  let canonical: string;
  try {
    canonical = normalizeHostname(new URL(`http://${host}/`).hostname);
  } catch {
    try {
      canonical = normalizeHostname(new URL(`http://[${host}]/`).hostname);
    } catch {
      canonical = normalizeHostname(host);
    }
  }
  const forms = [canonical];
  const g = parseIPv6(canonical);
  const zeros = (from: number, to: number) =>
    !!g && g.slice(from, to).every(x => x === 0);
  if (
    g &&
    ((zeros(0, 5) && g[5] === 0xffff) ||
      (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)))
  ) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
    if (parseIPv4(v4) !== null) forms.push(v4);
  }
  return forms;
}

/**
 * True if `hostname` equals a deny-list entry or is a subdomain of one.
 * Both sides are canonicalized (IDN, IP text forms, embedded IPv4), so
 * `Bücher.example`, `127.1` or `[::ffff:127.0.0.1]` can't slip past an
 * entry written another way. Overlong hostnames count as denied.
 */
export function hostMatchesDenyList(
  hostname: string,
  denyList: string[]
): boolean {
  if (isOverlongHostname(normalizeHostname(hostname))) return true;
  const hosts = hostForms(hostname);
  return denyList.some(entry => {
    if (!normalizeHostname(entry)) return false;
    return hostForms(entry).some(denied =>
      hosts.some(host => host === denied || host.endsWith('.' + denied))
    );
  });
}
