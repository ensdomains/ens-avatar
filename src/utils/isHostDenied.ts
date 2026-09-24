import {
  hostMatchesDenyList,
  isOverlongHostname,
  normalizeHostname,
} from './hostname';

/** True if the URL's host is on the deny list (or is not a valid host). */
export function isHostDenied(url: string, denyList?: string[]): boolean {
  try {
    const hostname = new URL(url).hostname;
    if (isOverlongHostname(normalizeHostname(hostname))) return true;
    if (!denyList?.length) return false;
    return hostMatchesDenyList(hostname, denyList);
  } catch {
    return true;
  }
}
