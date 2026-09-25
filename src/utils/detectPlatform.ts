const isBrowser: boolean =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

// Cloudflare Workers set this user agent. Check it first: with the
// `nodejs_compat` flag Workers also polyfill `process` (including
// `process.release.name === 'node'`), which would otherwise select the
// Node-only undici path.
const isWorkerdRuntime: boolean =
  typeof navigator !== 'undefined' &&
  (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers';

// Detect Node.js environment
const isNode =
  !isWorkerdRuntime &&
  typeof process !== 'undefined' &&
  process.release?.name === 'node';

// Detect Cloudflare Workers and other edge runtimes (not browser, not Node.js)
const isCloudflareWorker = !isBrowser && !isNode;

export { isBrowser, isNode, isCloudflareWorker };
