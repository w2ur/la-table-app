export type Strategy = "network" | "shell" | "cache";

/**
 * How the service worker answers a request. The API and Access always go to the network (state lives in IndexedDB,
 * spec §8.3); a navigation gets the cached app shell, except `?reconnexion`, the way back through an Access login;
 * a precached file comes from the cache; anything else from the network.
 */
export function strategyFor(url: URL, method: string, mode: RequestMode, origin: string, precached: ReadonlySet<string>): Strategy {
  if (method !== "GET" || url.origin !== origin) return "network";
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cdn-cgi/")) return "network";
  if (mode === "navigate") return url.searchParams.has("reconnexion") ? "network" : "shell";
  return precached.has(url.pathname) ? "cache" : "network";
}

export function cacheName(version: string): string {
  return `la-table-${version}`;
}

export function staleCaches(keys: readonly string[], current: string): string[] {
  return keys.filter((key) => key.startsWith("la-table-") && key !== current);
}
