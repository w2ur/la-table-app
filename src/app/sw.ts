import { cacheName, staleCaches, strategyFor } from "./sw-logic";

declare const self: ServiceWorkerGlobalScope;

interface SwManifest {
  version: string;
  urls: string[];
}

// The build (vite.config.ts, scripts/sw-manifest.ts) writes the precache list and its version in place of this token.
const manifest = JSON.parse("__LA_TABLE_SW_MANIFEST__") as SwManifest;
const CACHE = cacheName(manifest.version);
const precached = new Set(manifest.urls);

self.addEventListener("install", (event) => {
  // no skipWaiting: a new version waits until the owner taps « Mettre à jour » (sw-register.ts)
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(manifest.urls)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of staleCaches(await caches.keys(), CACHE)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const strategy = strategyFor(url, event.request.method, event.request.mode, self.location.origin, precached);
  if (strategy === "network") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(strategy === "shell" ? "/" : url.pathname);
    return hit ?? fetch(event.request);
  })());
});
