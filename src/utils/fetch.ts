import axios, { Axios } from 'axios';

export function createCacheAdapter(fetch: Axios, ttl: number) {
  // creates cache adapter for axios
  const { setupCache } = require('axios-cache-interceptor');
  setupCache(fetch, {
    ttl: ttl * 1000,
  });
}

function createFetcher({ ttl }: { ttl?: number }) {
  const _fetch = axios.create({ proxy: false });
  if (ttl && ttl > 0) {
    createCacheAdapter(_fetch, ttl);
  }
  return _fetch;
}

export const fetch = createFetcher({});
