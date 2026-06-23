import { Dispatcher } from 'undici';
import { isNode } from './detectPlatform';
import { isPrivateIp } from './ip';
import { Fetcher, FetcherResponse } from '../types';

const MAX_REDIRECTS = 10;

/**
 * Checks if a hostname denotes a private/reserved target.
 * Defense-in-depth URL-based check for all environments (the only SSRF defense
 * in browser/edge runtimes, since no Node agent is installed there).
 * Does NOT protect against DNS rebinding — use agent-based protection in Node.js.
 *
 * Two cases: DNS names that always denote local scopes (localhost, .local,
 * .internal, .localhost), and IP literals — which are canonicalized and
 * range-checked by isPrivateIp so every textual encoding (bracketed IPv6,
 * compressed `::`, hex-embedded / IPv4-mapped / NAT64 forms) is caught.
 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  // Strip the brackets the WHATWG URL parser puts around IPv6 hosts.
  const h = hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');

  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }

  return isPrivateIp(hostname);
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

// undici's buildConnector types use complex discriminated tuples (CallbackArgs)
// that differ across versions. We type the public boundary (Dispatcher return)
// and use runtime-safe patterns internally.
type LookupAddress = { address: string; family: number };
type LookupCb = (
  err: Error | null,
  address?: string | LookupAddress[],
  family?: number
) => void;
type ConnectorCb = (err: Error | null, socket: unknown) => void;

// The slices of Node's `net` / `dns` builtins the SSRF agent needs. They are
// injected (loaded via dynamic import in resolveRuntime) rather than required
// here, so this module is valid ESM and never statically pulls Node-only
// builtins into a browser/edge bundle.
interface NetModule {
  isIP(input: string): number;
}
interface DnsModule {
  lookup(
    hostname: string,
    options: Record<string, unknown>,
    callback: (
      err: Error | null,
      address: string | LookupAddress[],
      family: number
    ) => void
  ): void;
}

/**
 * Builds the SSRF-validating DNS lookup passed to undici's buildConnector.
 *
 * @internal — exported for tests. Node 20+ enables autoSelectFamily (Happy
 * Eyeballs), so undici invokes this lookup with `{ all: true }`, and
 * dns.lookup then returns an ARRAY of `{ address, family }` rather than a
 * single address. Both shapes must be handled: every resolved IP is checked
 * against the private-address rules, and the result is passed through
 * unchanged so undici's family selection keeps working.
 */
export function createSSRFSafeLookup(net: NetModule, dns: DnsModule) {
  const checkIP = (ip: string, hostname: string) => {
    if (isPrivateHostname(ip)) {
      throw new Error(
        `SSRF blocked: ${hostname} resolved to private address ${ip}`
      );
    }
  };

  return (
    hostname: string,
    options: Record<string, unknown>,
    callback: LookupCb
  ) => {
    const wantsAll = options && (options as { all?: boolean }).all === true;
    const family = net.isIP(hostname);

    // Layer 1: block IP literals before DNS
    if (family) {
      try {
        checkIP(hostname, hostname);
      } catch (e) {
        return callback(e as Error);
      }
      return wantsAll
        ? callback(null, [{ address: hostname, family }])
        : callback(null, hostname, family);
    }

    // Layer 2: validate every resolved DNS result
    dns.lookup(
      hostname,
      options,
      (
        err: Error | null,
        address: string | LookupAddress[],
        addrFamily: number
      ) => {
        if (err) return callback(err);
        try {
          if (Array.isArray(address)) {
            for (const entry of address) checkIP(entry.address, hostname);
          } else {
            checkIP(address, hostname);
          }
        } catch (e) {
          return callback(e as Error);
        }
        callback(null, address, addrFamily);
      }
    );
  };
}

/**
 * Creates an undici Agent with SSRF protection at the DNS and socket level.
 * `undici`, `net`, and `dns` are injected (dynamically imported on Node in
 * resolveRuntime) so this stays valid ESM and never statically pulls Node-only
 * modules into a browser/edge bundle.
 *
 * @internal — types are loose inside because undici's connector API
 * uses complex discriminated tuples that vary across versions.
 * The public return type (Dispatcher) is what matters.
 */
function createSSRFSafeAgent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  undici: { Agent: any; buildConnector: any },
  net: NetModule,
  dns: DnsModule
): Dispatcher {
  const { Agent, buildConnector } = undici;
  const connector = buildConnector({ lookup: createSSRFSafeLookup(net, dns) });

  return new Agent({
    connect: (opts: Record<string, unknown>, cb: ConnectorCb) => {
      connector(
        opts,
        (
          err: Error | null,
          socket: { remoteAddress?: string; destroy: () => void }
        ) => {
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
        }
      );
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
// Runtime resolution
//
// Node-only dependencies (undici, net, dns) are loaded lazily via dynamic
// import() on first request, never with require() and never as a static
// top-level import. This keeps the emitted module valid ESM (no `require is
// not defined`) while still not pulling Node-only packages into a browser/edge
// bundle, since the import() only executes on Node.
// ---------------------------------------------------------------------------

interface FetchRuntime {
  fetchFn: FetchFn;
  ssrfDispatcher?: Dispatcher;
}

// Normalize CJS/ESM interop for a dynamically-imported module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function interopDefault(ns: any): any {
  return (ns && ns.default) || ns;
}

async function resolveRuntime(
  dispatcher: Dispatcher | undefined,
  allowPrivateIPs: boolean | undefined
): Promise<FetchRuntime> {
  if (!isNode) {
    return { fetchFn: globalThis.fetch.bind(globalThis) };
  }

  const undici = interopDefault(await import('undici'));
  const fetchFn = undici.fetch as FetchFn;

  // User-provided dispatcher — use as-is, the caller owns SSRF safety.
  if (dispatcher) return { fetchFn, ssrfDispatcher: dispatcher };
  // Private IPs explicitly allowed — no SSRF agent.
  if (allowPrivateIPs) return { fetchFn };

  const [net, dns] = await Promise.all([
    import('net').then(interopDefault),
    import('dns').then(interopDefault),
  ]);
  return { fetchFn, ssrfDispatcher: createSSRFSafeAgent(undici, net, dns) };
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
  const cache = ttl && ttl > 0 ? new TTLCache(ttl) : null;

  // Resolve the runtime (fetch fn + optional SSRF dispatcher) once, lazily, on
  // the first request — keeps createFetcher synchronous and side-effect-free.
  let runtime: Promise<FetchRuntime> | undefined;
  const getRuntime = (): Promise<FetchRuntime> => {
    if (!runtime) runtime = resolveRuntime(dispatcher, allowPrivateIPs);
    return runtime;
  };

  async function doFetch(
    url: string,
    init: RequestInit & { dispatcher?: Dispatcher } = {}
  ): Promise<Response> {
    const { fetchFn, ssrfDispatcher } = await getRuntime();

    const fetchInit: RequestInit & {
      dispatcher?: Dispatcher;
      signal?: AbortSignal | null;
    } = { ...init };

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
      return await fetchWithRedirects(
        url,
        fetchInit as RequestInit & { dispatcher?: Dispatcher },
        {
          fetchFn,
          urlDenyList,
          allowPrivateIPs,
        }
      );
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
