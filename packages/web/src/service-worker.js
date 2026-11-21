/* global self, caches, fetch, URL, URLSearchParams, Request */

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

  const path = url.pathname;
  if (
    !shell.has(path) ||
    (request.mode !== "navigate" && (url.search || path === "/"))
  )
    return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(path)) ?? fetch(request);
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  if (
    typeof data?.title !== "string" ||
    typeof data.body !== "string" ||
    typeof data.url !== "string"
  )
    return;

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/heed-192.png",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL("/", self.location.origin);
  const link = event.notification.data?.url;
  if (typeof link === "string" && link.startsWith("/?")) {
    const item = new URLSearchParams(link.slice(2)).get("item");
    if (item) url.searchParams.set("item", item);
  }
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const app = clients.find(
        (client) => new URL(client.url).pathname === "/",
      );
      if (app) {
        // A fresh navigation selects the item even if it was previously closed.
        const window = url.search
          ? await app.navigate(url.href).catch(() => null)
          : app;
        if (window) {
          await window.focus();
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
