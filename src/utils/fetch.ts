import axios, { Axios } from 'axios';
import { isBrowser } from './detectPlatform';
import { AxiosAgents } from '../types';

export function createAgentAdapter(fetch: Axios, agents?: AxiosAgents) {
  if (!isBrowser && agents && Object.values(agents || {}).length) {
    fetch.interceptors.request.use(config => {
      config.httpAgent = agents.httpAgent;
      config.httpsAgent = agents.httpsAgent;
      return config;
    });
  }
}

export function createCacheAdapter(fetch: Axios, ttl: number) {
  // creates cache adapter for axios
  const { setupCache } = require('axios-cache-interceptor');
  setupCache(fetch, {
    ttl: ttl * 1000,
  });
}

function createFetcher({
  ttl,
  agents,
}: {
  ttl?: number;
  agents?: AxiosAgents;
}) {
  const _fetch = axios.create({
    proxy: false,
  });
  if (ttl && ttl > 0) {
    createCacheAdapter(_fetch, ttl);
  }
  if (Object.values(agents || {}).length) {
    createAgentAdapter(_fetch, agents);
  }
  return _fetch;
}

export const fetch = createFetcher({});
