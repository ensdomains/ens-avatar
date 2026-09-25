import { Dispatcher } from 'undici';
import { isNode } from './detectPlatform';
import {
  hostMatchesDenyList,
  isOverlongHostname,
  normalizeHostname,
} from './hostname';
import { isPrivateIp } from './ip';
import { parseJSON } from './json';
import { assertBoolean, assertLimit, assertStringArray } from './limits';
import { AvatarResolverOpts, Fetcher, FetcherResponse } from '../types';

/**
 * Default redirects followed per request. Each hop is a subrequest, and one
 * resolution makes up to five requests (record HEAD + sniff, metadata GET,
 * image HEAD + sniff), so the default bounds it at 30 HTTP subrequests
 * (Cloudflare Workers Free allows 50 per invocation).
 */
export const DEFAULT_MAX_REDIRECTS = 5;
/**
 * Default cap on a response body read by the fetcher (1 MiB). Metadata JSON
 * is small; a few MiB of hostile JSON (e.g. from a tiny compressed body) can
 * expand to far more memory once parsed.
 */
export const DEFAULT_MAX_CONTENT_LENGTH = 1024 * 1024;
// setTimeout clamps larger delays to 1 ms.
const MAX_TIMEOUT = 2 ** 31 - 1;
// Request headers that may follow a redirect to another origin. Anything else
// (API keys, Authorization, cookies) is dropped, as the Fetch spec does for
// Authorization.
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['accept', 'range']);

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
  // Lowercase, strip IPv6 brackets and trailing dots (`localhost.`, `127.0.0.1..`).
  const h = normalizeHostname(hostname);
  if (!h || isOverlongHostname(h)) return true;

  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }

  return isPrivateIp(h);
}

/**
 * Validates a URL against scheme, private hostname and deny list checks.
 * Throws unless the URL is http(s) and targets a public, non-denied host.
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

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // Only a real `true` disables the check (not e.g. the string "false").
  if (allowPrivateIPs !== true && isPrivateHostname(hostname)) {
    throw new Error(`Request to private address blocked: ${hostname}`);
  }

  if (urlDenyList?.length && hostMatchesDenyList(hostname, urlDenyList)) {
    throw new Error(`Request to denied host blocked: ${hostname}`);
  }
}

// ---------------------------------------------------------------------------
// TTL Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiry: number;
  size: number;
}

// Keys are attacker-influenced URLs, so the cache is bounded (LRU) by entry
// count and by size (UTF-16 code units of cached text).
export const MAX_CACHE_ENTRIES = 1000;
export const MAX_CACHE_SIZE = 8 * 1024 * 1024;

/** @internal — exported for tests. */
export class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private ttlMs: number;
  private size = 0;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  private remove(key: string): void {
    const entry = this.store.get(key);
    if (!entry) return;
    this.size -= entry.size;
    this.store.delete(key);
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    this.remove(key);
    if (Date.now() > entry.expiry) return undefined;
    this.store.set(key, entry); // most recently used goes last
    this.size += entry.size;
    return entry.value as T;
  }

  set<T>(key: string, value: T, size = 1): void {
    this.remove(key);
    if (size > MAX_CACHE_SIZE) return;
    const full = () =>
      this.store.size >= MAX_CACHE_ENTRIES || this.size + size > MAX_CACHE_SIZE;
    if (full()) {
      const now = Date.now();
      for (const [k, e] of this.store) if (now > e.expiry) this.remove(k);
    }
    while (full()) {
      this.remove(this.store.keys().next().value as string); // least recent
    }
    this.store.set(key, { value, expiry: Date.now() + this.ttlMs, size });
    this.size += size;
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

/** Discard a response body we won't read, so the connection is released. */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => {});
}

function stripCrossOriginHeaders(
  headers: RequestInit['headers']
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const kept: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    if (CROSS_ORIGIN_SAFE_HEADERS.has(key.toLowerCase())) kept[key] = value;
  });
  return kept;
}

async function fetchWithRedirects(
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher },
  opts: {
    fetchFn: FetchFn;
    urlDenyList?: string[];
    allowPrivateIPs?: boolean;
    maxRedirects: number;
  }
): Promise<Response> {
  let currentUrl = url;
  let headers = init.headers;
  const origin = new URL(url).origin;

  for (let i = 0; i <= opts.maxRedirects; i++) {
    validateUrl(currentUrl, opts.urlDenyList, opts.allowPrivateIPs);

    const response = await opts.fetchFn(currentUrl, {
      ...init,
      headers,
      redirect: 'manual',
    } as RequestInit);

    const status = response.status;
    if (status >= 300 && status < 400) {
      discardBody(response);
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect with no Location header from ${currentUrl}`);
      }
      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).toString();
      // Once a hop leaves the original origin, credentials stay behind.
      if (new URL(currentUrl).origin !== origin) {
        headers = stripCrossOriginHeaders(headers);
      }
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects (max ${opts.maxRedirects})`);
}

// ---------------------------------------------------------------------------
// Response header helper
// ---------------------------------------------------------------------------

/**
 * Read a response body, failing once it exceeds `maxBytes` (checked against
 * Content-Length up front, then while streaming, since the header can lie).
 */
async function readBodyCapped(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  const declared = parseInt(response.headers.get('content-length') || '', 10);
  if (declared > maxBytes) {
    discardBody(response);
    throw new Error(`Response body exceeds ${maxBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error(`Response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return concatChunks(chunks, total);
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

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
  if (allowPrivateIPs === true) return { fetchFn };

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
  maxContentLength = DEFAULT_MAX_CONTENT_LENGTH,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
}: {
  ttl?: number;
  dispatcher?: Dispatcher;
  allowPrivateIPs?: boolean;
  /** Deadline in ms for the whole request: redirects, headers and body. */
  timeout?: number;
  urlDenyList?: string[];
  /** Maximum response body size in bytes. */
  maxContentLength?: number;
  /** Maximum redirects followed per request. */
  maxRedirects?: number;
} = {}): Fetcher {
  if (ttl !== undefined) assertLimit('cache', ttl, { min: 0 }); // 0 = disabled
  assertBoolean('allowPrivateIPs', allowPrivateIPs);
  assertStringArray('urlDenyList', urlDenyList);
  assertLimit('timeout', timeout, { max: MAX_TIMEOUT });
  assertLimit('maxContentLength', maxContentLength);
  assertLimit('maxRedirects', maxRedirects, { min: 0, max: 20 });

  const cache = ttl && ttl > 0 ? new TTLCache(ttl) : null;

  // Resolve the runtime (fetch fn + optional SSRF dispatcher) once, lazily, on
  // the first request — keeps createFetcher synchronous and side-effect-free.
  let runtime: Promise<FetchRuntime> | undefined;
  const getRuntime = (): Promise<FetchRuntime> => {
    if (!runtime) runtime = resolveRuntime(dispatcher, allowPrivateIPs);
    return runtime;
  };

  /**
   * Fetch `url` and consume the response with `read`, all under one deadline:
   * the timeout aborts a stalled body as well as a stalled connection. A
   * caller-provided signal aborts the request too.
   */
  async function request<T>(
    url: string,
    init: RequestInit & { signal?: AbortSignal },
    read: (response: Response) => Promise<T>
  ): Promise<T> {
    const { fetchFn, ssrfDispatcher } = await getRuntime();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const callerSignal = init.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort);

    const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
      ...init,
      signal: controller.signal,
    };
    if (ssrfDispatcher) {
      fetchInit.dispatcher = ssrfDispatcher;
    }

    try {
      const response = await fetchWithRedirects(url, fetchInit, {
        fetchFn,
        urlDenyList,
        allowPrivateIPs,
        maxRedirects,
      });
      return await read(response);
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  const fetcher: Fetcher = {
    async get<T = unknown>(
      url: string,
      opts?: { headers?: Record<string, string> }
    ): Promise<FetcherResponse<T>> {
      // Headers are part of the key: a response fetched with an API key must
      // not be served to a request without one (or vice versa).
      const cacheKey = `get:${url}:${JSON.stringify(opts?.headers ?? {})}`;
      // The body text is cached (not the parsed object): its size is what the
      // cache budget measures, and each hit gets a fresh object.
      type Cached = {
        status: number;
        headers: Record<string, string>;
        text: string;
      };
      const toResult = (c: Cached): FetcherResponse<T> => ({
        status: c.status,
        headers: c.headers,
        data: parseJSON(c.text) as T,
      });
      if (cache) {
        const cached = cache.get<Cached>(cacheKey);
        if (cached) return toResult(cached);
      }

      const entry = await request(
        url,
        { method: 'GET', headers: opts?.headers },
        async (response): Promise<Cached> => {
          const body = await readBodyCapped(response, maxContentLength);
          return {
            status: response.status,
            headers: headersToRecord(response.headers),
            text: new TextDecoder().decode(body),
          };
        }
      );

      const result = toResult(entry);
      if (cache) {
        cache.set(
          cacheKey,
          entry,
          entry.text.length + JSON.stringify(entry.headers).length
        );
      }
      return result;
    },

    async head(url: string): Promise<FetcherResponse<void>> {
      const cacheKey = `head:${url}`;
      if (cache) {
        const cached = cache.get<FetcherResponse<void>>(cacheKey);
        if (cached) return cached;
      }

      const result = await request(
        url,
        { method: 'HEAD' },
        async (response): Promise<FetcherResponse<void>> => {
          discardBody(response);
          return {
            status: response.status,
            headers: headersToRecord(response.headers),
            data: undefined,
          };
        }
      );

      if (cache) {
        cache.set(cacheKey, result, JSON.stringify(result.headers).length);
      }
      return result;
    },

    async getArrayBuffer(
      url: string,
      opts?: { headers?: Record<string, string>; signal?: AbortSignal }
    ): Promise<FetcherResponse<ArrayBuffer>> {
      return request(
        url,
        { method: 'GET', headers: opts?.headers, signal: opts?.signal },
        async (response): Promise<FetcherResponse<ArrayBuffer>> => {
          // Read only the first 1024 bytes then cancel the stream
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

          return {
            status: response.status,
            headers: headersToRecord(response.headers),
            data: concatChunks(chunks, totalBytes).buffer as ArrayBuffer,
          };
        }
      );
    },
  };

  return fetcher;
}

/** A fetcher configured from the resolver options. */
export function createFetcherFromOptions(
  options?: AvatarResolverOpts
): Fetcher {
  return createFetcher({
    ttl: options?.cache,
    dispatcher: options?.dispatcher,
    allowPrivateIPs: options?.allowPrivateIPs,
    timeout: options?.timeout,
    urlDenyList: options?.urlDenyList,
    maxContentLength: options?.maxContentLength,
    maxRedirects: options?.maxRedirects,
  });
}

// Default fetch instance without any configuration
export const fetch = createFetcher({});
