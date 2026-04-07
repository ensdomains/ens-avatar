export function isHostDenied(url: string, denyList?: string[]): boolean {
  if (!denyList?.length) return false;
  try {
    const hostname = new URL(url).hostname;
    return denyList.some(
      denied => hostname === denied || hostname.endsWith('.' + denied)
    );
  } catch {
    return true;
  }
}
