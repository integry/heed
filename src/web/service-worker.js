/* global self, caches, fetch, URL, Request */

const CACHE_PREFIX = "heed-app-shell-";
// The build inserts content-versioned shell assets.
const { version, paths } = /* APP_SHELL */ { version: "", paths: [] };
const CACHE_NAME = CACHE_PREFIX + version;
const shell = new Set(paths);
const serverRoute = /^\/(?:api|auth|ws|mcp)(?:\/|$)/;

self.addEventListener("install", (event) => {
  const requests = paths.map(
    (path) =>
      new Request(new URL(path, self.location.origin), {
        cache: "reload",
        credentials: "omit",
      }),
  );
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(requests)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    request.headers.has("upgrade") ||
    serverRoute.test(url.pathname)
  )
    return;

  const path =
    request.mode === "navigate" && url.pathname === "/"
      ? "/index.html"
      : url.pathname;
  if (!shell.has(path) || (url.search && request.mode !== "navigate")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(path)) ?? fetch(request);
    })(),
  );
});
