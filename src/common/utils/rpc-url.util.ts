export function uniqueRpcUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of urls) {
    const url = raw.trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    unique.push(url);
  }
  return unique;
}

export function parseRpcUrlList(value: string | undefined): string[] {
  return uniqueRpcUrls((value ?? '').split(','));
}

export function isHttpRpcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Host only, so logs do not include API keys embedded in the URL. */
export function rpcHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'invalid';
  }
}
