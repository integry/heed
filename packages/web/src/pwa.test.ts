import { expect, it, vi } from "vitest";
import manifestSource from "./public/manifest.webmanifest?raw";
import shellHtml from "./index.html?raw";
import workerSource from "./service-worker.js?raw";

it("declares a standalone PWA with matching icon assets and iOS metadata", () => {
  const manifest = JSON.parse(manifestSource);
  const files = import.meta.glob("./public/icons/*.png", {
    eager: true,
    query: "?url",
  });
  expect(manifest).toMatchObject({
    name: "Heed",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: expect.stringMatching(/^#[0-9a-f]{6}$/),
    background_color: expect.stringMatching(/^#[0-9a-f]{6}$/),
    icons: [
      { src: "/icons/heed-192.png", sizes: "192x192", type: "image/png" },
      {
        src: "/icons/heed-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: expect.stringContaining("maskable"),
      },
    ],
  });
  for (const { src } of manifest.icons)
    expect(files[`./public${src}`]).toBeDefined();

  const document = new DOMParser().parseFromString(shellHtml, "text/html");
  expect(
    document.querySelector('link[rel="manifest"]')?.getAttribute("href"),
  ).toBe("/manifest.webmanifest");
  const touchIcon = document
    .querySelector('link[rel="apple-touch-icon"]')
    ?.getAttribute("href");
  expect(files[`./public${touchIcon}`]).toBeDefined();
  expect(
    document
      .querySelector('meta[name="apple-mobile-web-app-capable"]')
      ?.getAttribute("content"),
  ).toBe("yes");
});

function startWorker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const addAll = vi.fn<(requests: Request[]) => Promise<void>>(async () => {});
  const match = vi.fn(async (path: string) => new Response(path));
  const open = vi.fn(async () => ({ match, addAll }));
  const skipWaiting = vi.fn(async () => {});
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const matchAll = vi.fn<() => Promise<object[]>>(async () => []);
  const self = {
    registration: { showNotification },
    clients: { matchAll, openWindow },
    location: { origin: "https://heed.example" },
    addEventListener: (name: string, handler: (event: unknown) => void) =>
      handlers.set(name, handler),
    skipWaiting,
  };
  const paths = ["/", "/assets/app.js", "/manifest.webmanifest"];
  const worker = workerSource.replace(
    /\/\* APP_SHELL \*\/ \{ version: "", paths: \[\] \}/,
    JSON.stringify({ version: "test", paths }),
  );
  new Function("self", "caches", worker)(self, { open });

  function request(path: string, init: RequestInit = {}) {
    const { mode, ...options } = init;
    const request = new Request(new URL(path, self.location.origin), options);
    if (mode) Object.defineProperty(request, "mode", { value: mode });
    const respondWith = vi.fn<(response: Promise<Response>) => void>();
    handlers.get("fetch")!({ request, respondWith });
    return respondWith.mock.lastCall?.[0];
  }

  return {
    request,
    handlers,
    addAll,
    open,
    skipWaiting,
    paths,
    showNotification,
    matchAll,
    openWindow,
  };
}

it("does not intercept server routes, upgrades, writes, or unlisted assets", () => {
  const { request, open } = startWorker();
  for (const path of [
    "/",
    "/api",
    "/api/me",
    "/api/items?day=today",
    "/auth",
    "/auth/login",
    "/auth/callback?code=test",
    "/ws",
    "/ws/",
    "/mcp",
    "/mcp/messages",
    "/assets/unlisted.js",
    "/assets/app.js?v=previous",
    "https://other.example/index.html",
  ])
    expect(request(path)).toBeUndefined();
  expect(request("/", { headers: { Upgrade: "websocket" } })).toBeUndefined();
  expect(request("/", { method: "POST" })).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});

it("precaches only the build shell and serves its cached assets", async () => {
  const { request, handlers, addAll, open, paths } = startWorker();
  const waitUntil = vi.fn<(promise: Promise<void>) => void>();
  handlers.get("install")!({ waitUntil });
  await waitUntil.mock.lastCall?.[0];
  expect(open).toHaveBeenCalledWith("heed-app-shell-test");
  const [requests] = addAll.mock.lastCall!;
  expect(requests.map(({ url }) => new URL(url).pathname)).toEqual(paths);
  expect(requests.every(({ credentials }) => credentials === "omit")).toBe(
    true,
  );
  const deepLink = await request("/?item=7be25709bbbb41bc", {
    mode: "navigate",
  });
  expect(await deepLink?.text()).toBe("/");
  expect(await (await request("/assets/app.js"))?.text()).toBe(
    "/assets/app.js",
  );
});

it("waits for the update action before calling skipWaiting", async () => {
  const { handlers, skipWaiting } = startWorker();
  const waitUntil = vi.fn<(promise: Promise<void>) => void>();
  handlers.get("message")!({ data: "unrelated", waitUntil });
  expect(skipWaiting).not.toHaveBeenCalled();
  handlers.get("message")!({ data: "SKIP_WAITING", waitUntil });
  await waitUntil.mock.lastCall?.[0];
  expect(skipWaiting).toHaveBeenCalledOnce();
});

it("shows the handoff title and note, and opens its item on click", async () => {
  const { handlers, showNotification, matchAll, openWindow } = startWorker();
  const waitUntil = vi.fn<(promise: Promise<void>) => void>();
  const url = "/?item=7be25709bbbb41bc";
  handlers.get("push")!({
    waitUntil,
    data: { json: () => ({ title: "Rollout", body: "Approve deploy", url }) },
  });
  await waitUntil.mock.lastCall?.[0];
  expect(showNotification).toHaveBeenCalledExactlyOnceWith("Rollout", {
    body: "Approve deploy",
    icon: "/icons/heed-192.png",
    data: { url },
  });

  const close = vi.fn();
  const notification = { close, data: { url } };
  handlers.get("notificationclick")!({ waitUntil, notification });
  await waitUntil.mock.lastCall?.[0];
  expect(close).toHaveBeenCalledOnce();
  expect(openWindow).toHaveBeenCalledWith("https://heed.example" + url);

  const focus = vi.fn(async () => {});
  const navigate = vi.fn(async () => ({ focus }));
  matchAll.mockResolvedValueOnce([{ url: "https://heed.example/", navigate }]);
  handlers.get("notificationclick")!({ waitUntil, notification });
  await waitUntil.mock.lastCall?.[0];
  expect(navigate).toHaveBeenCalledWith("https://heed.example" + url);
  expect(focus).toHaveBeenCalledOnce();
});
