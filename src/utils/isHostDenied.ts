import { hostMatchesDenyList } from './hostname';

export function isHostDenied(url: string, denyList?: string[]): boolean {
  if (!denyList?.length) return false;
  try {
    return hostMatchesDenyList(new URL(url).hostname, denyList);
  } catch {
    return true;
  }
}
