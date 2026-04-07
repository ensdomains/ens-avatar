import type { Dispatcher } from 'undici';
import { isNode } from './detectPlatform';
import { Fetcher, FetcherResponse } from '../types';

const MAX_REDIRECTS = 10;

/**
 * Checks if a hostname is a private/reserved IP address.
 * Defense-in-depth URL-based check for all environments.
 * Does NOT protect against DNS rebinding — use agent-based protection in Node.js.
 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase();

  // Loopback
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::')
    return true;
  if (/^127\./.test(h) || /^0\./.test(h)) return true;

  // Private IPv4 (RFC 1918)
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;

  // Link-local — covers cloud metadata endpoints (AWS 169.254.169.254, etc.)
  if (/^169\.254\./.test(h)) return true;

  // CGNAT / Shared Address Space (RFC 6598) — used by cloud providers internally
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;

  // Private TLDs
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost'))
    return true;

  // IPv6 checks — only apply to actual IPv6 addresses (contain ':')
  if (h.includes(':')) {
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
    if (/^f[cd]/.test(h)) return true;
    if (/^fe[89ab]/.test(h)) return true;

    // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:10.x.x.x, etc.)
    const v4Mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) return isPrivateHostname(v4Mapped[1]);
  }

  return false;
}

/**
 * Validates a URL against private hostname and deny list checks.
 * Throws if the URL targets a private address or denied host.
 */
export function validateUrl(
  url: string,
  urlDenyList?: string[],
  allowPrivateIPs?: boolean
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const hostname = parsed.hostname;

  if (!allowPrivateIPs && isPrivateHostname(hostname)) {
    throw new Error(`Request to private address blocked: ${hostname}`);
  }

  if (
    urlDenyList?.length &&
    urlDenyList.some(
      denied => hostname === denied || hostname.endsWith('.' + denied)
    )
  ) {
    throw new Error(`Request to denied host blocked: ${hostname}`);
  }
}

// ---------------------------------------------------------------------------
// TTL Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiry: number;
}

class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private ttlMs: number;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, { value, expiry: Date.now() + this.ttlMs });
  }
}

// ---------------------------------------------------------------------------
// SSRF-safe undici Agent (Node.js only)
// ---------------------------------------------------------------------------

/**
 * Creates an undici Agent with SSRF protection at the DNS and socket level.
 * Uses require() because this only runs on Node.js.
 *
 * @internal — types are loose inside because undici's connector API
 * uses complex discriminated tuples that vary across versions.
 * The public return type (Dispatcher) is what matters.
 */
function createSSRFSafeAgent(): Dispatcher {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const net = require('net');
  const { Agent, buildConnector } = require('undici');
  const dns = require('dns');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const checkIP = (ip: string, hostname: string) => {
    if (isPrivateHostname(ip)) {
      throw new Error(
        `SSRF blocked: ${hostname} resolved to private address ${ip}`
      );
    }
  };

  // undici's buildConnector types use complex discriminated tuples (CallbackArgs)
  // that differ across versions. We type the public boundary (Dispatcher return)
  // and use runtime-safe patterns internally.
  type LookupCb = (err: Error | null, address?: string, family?: number) => void;
  type ConnectorCb = (err: Error | null, socket: unknown) => void;

  const connector = buildConnector({
    lookup: (hostname: string, options: Record<string, unknown>, callback: LookupCb) => {
      // Layer 1: block IP literals before DNS
      if (net.isIP(hostname)) {
        checkIP(hostname, hostname);
        return callback(null, hostname, net.isIP(hostname));
      }

      // Layer 2: validate DNS results
      dns.lookup(hostname, options, (err: Error | null, address: string, family: number) => {
        if (err) return callback(err);
        try {
          checkIP(address, hostname);
        } catch (e) {
          return callback(e as Error);
        }
        callback(null, address, family);
      });
    },
  });

  return new Agent({
    connect: (opts: Record<string, unknown>, cb: ConnectorCb) => {
      connector(opts, (err: Error | null, socket: { remoteAddress?: string; destroy: () => void }) => {
        if (err || !socket) return cb(err, null);

        // Layer 3: post-connect validation
        const remoteAddr = socket.remoteAddress;
        if (remoteAddr && isPrivateHostname(remoteAddr)) {
          socket.destroy();
          return cb(
            new Error(
              `SSRF blocked: connection to private address ${remoteAddr}`
            ),
            null
          );
        }

        cb(null, socket);
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Fetch with manual redirect following
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

async function fetchWithRedirects(
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher },
  opts: {
    fetchFn: FetchFn;
    urlDenyList?: string[];
    allowPrivateIPs?: boolean;
  }
): Promise<Response> {
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    validateUrl(currentUrl, opts.urlDenyList, opts.allowPrivateIPs);

    const response = await opts.fetchFn(currentUrl, {
      ...init,
      redirect: 'manual',
    } as RequestInit);

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect with no Location header from ${currentUrl}`);
      }
      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

// ---------------------------------------------------------------------------
// Response header helper
// ---------------------------------------------------------------------------

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

// ---------------------------------------------------------------------------
// createFetcher
// ---------------------------------------------------------------------------

export function createFetcher({
  ttl,
  dispatcher,
  allowPrivateIPs,
  timeout = 30000,
  urlDenyList,
}: {
  ttl?: number;
  dispatcher?: Dispatcher;
  allowPrivateIPs?: boolean;
  timeout?: number;
  urlDenyList?: string[];
} = {}): Fetcher {
  // Determine fetch function and SSRF dispatcher
  let fetchFn: FetchFn;
  let ssrfDispatcher: Dispatcher | undefined;

  if (isNode) {
    const undici = require('undici') as typeof import('undici');
    fetchFn = undici.fetch as FetchFn;

    if (dispatcher) {
      // User-provided dispatcher — use as-is, user owns security
      ssrfDispatcher = dispatcher;
    } else if (!allowPrivateIPs) {
      ssrfDispatcher = createSSRFSafeAgent();
    }
  } else {
    fetchFn = globalThis.fetch.bind(globalThis);
  }

  const cache = ttl && ttl > 0 ? new TTLCache(ttl) : null;

  async function doFetch(
    url: string,
    init: RequestInit & { dispatcher?: Dispatcher } = {}
  ): Promise<Response> {
    const fetchInit: RequestInit & { dispatcher?: Dispatcher; signal?: AbortSignal | null } = { ...init };

    if (ssrfDispatcher) {
      fetchInit.dispatcher = ssrfDispatcher;
    }

    // Timeout via AbortController — clear timer on completion to prevent leaks
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (!fetchInit.signal) {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeout);
      fetchInit.signal = controller.signal;
    }

    try {
      return await fetchWithRedirects(url, fetchInit as RequestInit & { dispatcher?: Dispatcher }, {
        fetchFn: fetchFn!,
        urlDenyList,
        allowPrivateIPs,
      });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  const fetcher: Fetcher = {
    async get<T = unknown>(
      url: string,
      opts?: { headers?: Record<string, string> }
    ): Promise<FetcherResponse<T>> {
      const cacheKey = `get:${url}`;
      if (cache) {
        const cached = cache.get<FetcherResponse<T>>(cacheKey);
        if (cached) return cached;
      }

      const response = await doFetch(url, {
        method: 'GET',
        headers: opts?.headers,
      });

      const data = (await response.json()) as T;
      const result: FetcherResponse<T> = {
        status: response.status,
        headers: headersToRecord(response.headers),
        data,
      };

      if (cache) cache.set(cacheKey, result);
      return result;
    },

    async head(url: string): Promise<FetcherResponse<void>> {
      const cacheKey = `head:${url}`;
      if (cache) {
        const cached = cache.get<FetcherResponse<void>>(cacheKey);
        if (cached) return cached;
      }

      const response = await doFetch(url, { method: 'HEAD' });

      const result = {
        status: response.status,
        headers: headersToRecord(response.headers),
        data: undefined,
      } as FetcherResponse<void>;

      if (cache) cache.set(cacheKey, result);
      return result;
    },

    async getArrayBuffer(
      url: string,
      opts?: { headers?: Record<string, string>; signal?: AbortSignal }
    ): Promise<FetcherResponse<ArrayBuffer>> {
      const response = await doFetch(url, {
        method: 'GET',
        headers: opts?.headers,
        signal: opts?.signal,
      });

      // Read only first 1024 bytes then cancel the stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      try {
        while (totalBytes < 1024) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value as Uint8Array);
          totalBytes += (value as Uint8Array).byteLength;
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      // Merge chunks into a single ArrayBuffer
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        data: merged.buffer,
      };
    },
  };

  return fetcher;
}

// Default fetch instance without any configuration
export const fetch = createFetcher({});
