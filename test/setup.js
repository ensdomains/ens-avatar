// Jest setup file to polyfill fetch for test environment
// In Node.js 18+, fetch is built-in but may not be available in Jest's test environment
// We'll use a lightweight fetch polyfill for testing

/* eslint-env node */
/* global globalThis */

try {
  // Try to load native fetch from node (Node 18+)
  const nodeFetch = globalThis.fetch;
  if (!nodeFetch) {
    throw new Error('Fetch not available');
  }
} catch (e) {
  // If native fetch is not available, we'll let axios fall back to http adapter
  // which is perfectly fine for testing purposes
  console.log(
    'Note: Using HTTP adapter for tests (fetch not available in Jest environment)'
  );
}
