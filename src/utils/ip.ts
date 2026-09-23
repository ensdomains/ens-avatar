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

// IPv4 ranges that are not globally routable unicast (IANA IPv4
// Special-Purpose Address Registry, plus multicast and reserved space).
// [network, prefix length]
const NON_PUBLIC_IPV4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private (RFC 1918)
  [0x64400000, 10], // 100.64.0.0/10 CGNAT (RFC 6598)
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12 private (RFC 1918)
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24 deprecated 6to4 relay anycast
  [0xc0a80000, 16], // 192.168.0.0/16 private (RFC 1918)
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved, incl. 255.255.255.255 broadcast
];

/**
 * True if a uint32 IPv4 address is NOT globally routable unicast: private,
 * loopback, link-local, CGNAT, documentation, benchmarking, multicast,
 * reserved, broadcast, or "this network".
 */
export function isPrivateIPv4(n: number): boolean {
  return NON_PUBLIC_IPV4.some(([net, len]) => {
    const mask = (~0 << (32 - len)) >>> 0;
    return (n & mask) >>> 0 === net;
  });
}

/**
 * True if eight IPv6 groups do NOT denote a globally routable unicast address.
 *
 * Allowlist: only global unicast (2000::/3) can be public, minus the
 * special-purpose blocks inside it. Addresses embedding an IPv4 address
 * (IPv4-mapped, NAT64 well-known prefix) are classified by that IPv4 address.
 * Everything else — ::, ::1, IPv4-compatible, IPv4-translated
 * (::ffff:0:0:0/96), local-use NAT64 (64:ff9b:1::/48), discard (100::/64),
 * ULA, link-local, site-local, multicast — is not public.
 */
export function isPrivateIPv6(g: number[]): boolean {
  const embeddedV4 = () => isPrivateIPv4(((g[6] << 16) | g[7]) >>> 0);
  const zeros = (from: number, to: number) =>
    g.slice(from, to).every(x => x === 0);

  // IPv4-mapped ::ffff:a.b.c.d
  if (zeros(0, 5) && g[5] === 0xffff) return embeddedV4();
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return embeddedV4();

  // Outside global unicast 2000::/3: never public.
  if ((g[0] & 0xe000) !== 0x2000) return true;

  // 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32)
  if (g[0] === 0x2001 && g[1] < 0x0200) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return true; // 2002::/16 6to4 (deprecated; embeds IPv4)
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation (RFC 9637)
  if (g[0] === 0x5f00) return true; // 5f00::/16 SRv6 SIDs (RFC 9602)
  return false;
}

/**
 * True if `host` is an IP literal (in any textual encoding) that is not a
 * globally routable unicast address. Returns false for DNS hostnames and public IPs.
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
