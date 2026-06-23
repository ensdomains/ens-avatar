/**
 * Runtime-agnostic IP address parsing and private/reserved-range classification.
 *
 * SSRF protection cannot rely on string-prefix matching: the same address has
 * many textual encodings (bracketed IPv6 from the WHATWG URL parser, compressed
 * `::` forms, hex-embedded IPv4 like `::ffff:7f00:1`, IPv4-mapped/compatible and
 * NAT64 embeddings). This module canonicalizes an address to its numeric form
 * and checks it against the reserved ranges, so every encoding of the same
 * target is classified identically. It uses no Node APIs, so it behaves the
 * same in Node, browsers, and edge runtimes.
 */

/** Parse a dotted-decimal IPv4 string to a uint32, or null if not IPv4. */
export function parseIPv4(input: string): number | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = parseInt(part, 10);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

function hexGroup(group: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
  return parseInt(group, 16);
}

/**
 * Parse an IPv6 string into its eight 16-bit groups, or null if not IPv6.
 * Handles `::` compression, a trailing embedded IPv4 (dotted), and zone ids.
 */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.indexOf(':') === -1) return null;
  if (!/^[0-9a-f:.]+$/.test(s)) return null;

  // Pull off a trailing embedded IPv4 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4, ::1.2.3.4)
  // and represent it as the final two 16-bit groups.
  let embeddedV4: number[] = [];
  if (s.indexOf('.') !== -1) {
    const match = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
    if (!match) return null;
    const v4 = parseIPv4(match[2]);
    if (v4 === null) return null;
    embeddedV4 = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    s = match[1];
    if (!s.endsWith('::') && s.endsWith(':')) s = s.slice(0, -1);
  }

  let head: string[];
  let tail: string[];
  const doubleColon = s.indexOf('::');
  if (doubleColon !== -1) {
    if (s.indexOf('::', doubleColon + 1) !== -1) return null; // only one `::` allowed
    const before = s.slice(0, doubleColon);
    const after = s.slice(doubleColon + 2);
    head = before ? before.split(':') : [];
    tail = after ? after.split(':') : [];
  } else {
    head = s ? s.split(':') : [];
    tail = [];
  }

  const headNums: number[] = [];
  for (const g of head) {
    const n = hexGroup(g);
    if (n === null) return null;
    headNums.push(n);
  }
  const tailNums: number[] = [];
  for (const g of tail) {
    const n = hexGroup(g);
    if (n === null) return null;
    tailNums.push(n);
  }

  const provided = headNums.length + tailNums.length + embeddedV4.length;
  let groups: number[];
  if (doubleColon !== -1) {
    if (provided > 8) return null;
    groups = [
      ...headNums,
      ...new Array(8 - provided).fill(0),
      ...tailNums,
      ...embeddedV4,
    ];
  } else {
    groups = [...headNums, ...tailNums, ...embeddedV4];
  }
  return groups.length === 8 ? groups : null;
}

/** True if a uint32 IPv4 address is loopback / private / link-local / CGNAT / unspecified. */
export function isPrivateIPv4(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
  return false;
}

/** True if eight IPv6 groups denote a loopback / private / link-local / embedded-private address. */
export function isPrivateIPv6(g: number[]): boolean {
  const embeddedV4 = () => isPrivateIPv4(((g[6] << 16) | g[7]) >>> 0);

  if (g.every(x => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true; // ::1 loopback

  // IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::/96):
  // classify by the embedded IPv4 so 127.0.0.1 in any embedding is caught.
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return embeddedV4();
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return embeddedV4();
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * True if `host` is an IP literal (in any textual encoding) that targets a
 * private/reserved range. Returns false for DNS hostnames and public IPs.
 * Surrounding brackets (as produced by `new URL(...).hostname` for IPv6) are
 * stripped before parsing.
 */
export function isPrivateIp(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  const v4 = parseIPv4(h);
  if (v4 !== null) return isPrivateIPv4(v4);
  const v6 = parseIPv6(h);
  if (v6 !== null) return isPrivateIPv6(v6);
  return false;
}
