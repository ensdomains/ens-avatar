import axios, { Axios, AxiosInstance } from 'axios';
import { isBrowser } from './detectPlatform';
import { AxiosAgents } from '../types';

// Detect Cloudflare Workers, which has fetch but no window/Node.js modules
const isCloudflareWorker =
  typeof globalThis !== 'undefined' &&
  !isBrowser &&
  typeof globalThis.fetch === 'function';

let http: any;
let https: any;
let requestFilterHandler: any;

// Dynamically import Node.js modules only in Node.js environment
// Skip for browsers and Cloudflare Workers (which don't have Node.js modules)
if (!isBrowser && !isCloudflareWorker) {
  http = require('http');
  https = require('https');
  const ssrfFilter = require('ssrf-req-filter');
  requestFilterHandler = ssrfFilter.requestFilterHandler;
}

/**
 * Creates an axios instance with fetch adapter and optional configuration
 *
 * SSRF PROTECTION BEHAVIOR:
 * - If NO custom agents provided: Automatically creates agents with SSRF protection
 *   that blocks private IPs (localhost, 127.x.x.x, 10.x.x.x, 192.168.x.x, etc.)
 * - If custom agents provided: Uses them as-is WITHOUT wrapping or modifying them.
 *   You are responsible for ensuring your custom agents have appropriate security.
 * - If allowPrivateIPs=true: Disables SSRF protection (only for local development)
 *
 * @param ttl - Cache time-to-live in seconds
 * @param agents - Custom HTTP/HTTPS agents (bypasses built-in SSRF protection)
 * @param maxContentLength - Maximum response content length in bytes
 * @param allowPrivateIPs - Allow private IPs (localhost, 127.0.0.1, etc.) - ONLY for development
 * @returns Configured axios instance
 */
export function createFetcher({
  ttl,
  agents,
  maxContentLength,
  allowPrivateIPs,
}: {
  ttl?: number;
  agents?: AxiosAgents;
  maxContentLength?: number;
  allowPrivateIPs?: boolean;
} = {}): Axios | AxiosInstance {
  const baseConfig: any = {
    // Use fetch adapter when available (browser, Cloudflare Workers, Node.js with fetch support)
    // Falls back to default adapters (xhr in browser, http in Node.js) if fetch is not available
    adapter: typeof globalThis.fetch !== 'undefined' ? 'fetch' : undefined,
    proxy: false,
    ...(maxContentLength && { maxContentLength }),
  };

  const _fetch = axios.create(baseConfig);

  let fetchInstance: Axios | AxiosInstance = _fetch;

  // Apply caching if TTL is specified
  if (ttl && ttl > 0) {
    const { setupCache } = require('axios-cache-interceptor');
    fetchInstance = setupCache(_fetch, {
      ttl: ttl * 1000,
    });
  }

  // Apply agent configuration for Node.js environments only
  // Cloudflare Workers don't support HTTP agents (use native fetch with built-in SSRF protection)
  if (!isBrowser && !isCloudflareWorker) {
    let finalAgents: AxiosAgents = {};

    if (agents && Object.values(agents).length) {
      // User provided custom agents - use them as-is without wrapping
      // They may have their own SSRF protection or specific requirements
      finalAgents = agents;
    } else if (!allowPrivateIPs && http && https && requestFilterHandler) {
      // No custom agents provided - create default agents with SSRF protection
      finalAgents = {
        httpAgent: requestFilterHandler(new http.Agent()),
        httpsAgent: requestFilterHandler(new https.Agent()),
      };
    }
    // If allowPrivateIPs is true and no custom agents, don't create any agents
    // (will use axios defaults which allow all IPs)

    // Apply agents if available
    if (Object.values(finalAgents).length) {
      fetchInstance.interceptors.request.use(config => {
        // Note: In axios 1.x with fetch adapter, use 'dispatcher' for undici agent
        // For backward compatibility, we support both httpAgent/httpsAgent and dispatcher
        if (finalAgents.httpAgent || finalAgents.httpsAgent) {
          // Legacy support - map to dispatcher if available
          // @ts-ignore - dispatcher is not in standard axios types but supported by fetch adapter
          config.dispatcher = finalAgents.httpAgent || finalAgents.httpsAgent;
        }
        return config;
      });
    }
  }

  return fetchInstance;
}

/**
 * @deprecated Use createFetcher instead. This will be removed in a future version.
 */
export function createAgentAdapter(fetch: Axios, agents?: AxiosAgents) {
  if (!isBrowser && agents && Object.values(agents || {}).length) {
    fetch.interceptors.request.use(config => {
      // @ts-ignore
      config.dispatcher = agents.httpAgent || agents.httpsAgent;
      return config;
    });
  }
}

/**
 * @deprecated Use createFetcher instead. This will be removed in a future version.
 */
export function createCacheAdapter(fetch: Axios, ttl: number): AxiosInstance {
  const { setupCache } = require('axios-cache-interceptor');
  return setupCache(fetch, {
    ttl: ttl * 1000,
  });
}

// Default fetch instance without any configuration
export const fetch = createFetcher({});
