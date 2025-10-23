const isBrowser: boolean =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

// Detect Node.js environment
const isNode =
  typeof process !== 'undefined' && process.release?.name === 'node';

// Detect Cloudflare Workers and other edge runtimes (not browser, not Node.js)
const isCloudflareWorker = !isBrowser && !isNode;

export { isBrowser, isNode, isCloudflareWorker };
