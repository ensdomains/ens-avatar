const isBrowser: boolean =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

export { isBrowser };
