import axios, { Axios, AxiosInstance } from 'axios';
import { isBrowser } from './detectPlatform';
import { AxiosAgents } from '../types';

/**
 * Creates an axios instance with fetch adapter and optional configuration
 * @param ttl - Cache time-to-live in seconds
 * @param agents - HTTP/HTTPS agents for Node.js (mapped to dispatcher for fetch adapter)
 * @param maxContentLength - Maximum response content length in bytes
 * @returns Configured axios instance
 */
export function createFetcher({
  ttl,
  agents,
  maxContentLength,
}: {
  ttl?: number;
  agents?: AxiosAgents;
  maxContentLength?: number;
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

  // Apply agent configuration for Node.js environments
  if (!isBrowser && agents && Object.values(agents || {}).length) {
    fetchInstance.interceptors.request.use(config => {
      // Note: In axios 1.x with fetch adapter, use 'dispatcher' for undici agent
      // For backward compatibility, we support both httpAgent/httpsAgent and dispatcher
      if (agents.httpAgent || agents.httpsAgent) {
        // Legacy support - map to dispatcher if available
        // @ts-ignore - dispatcher is not in standard axios types but supported by fetch adapter
        config.dispatcher = agents.httpAgent || agents.httpsAgent;
      }
      return config;
    });
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
