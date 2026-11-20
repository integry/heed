import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import worker from "./index";
import { SESSION_COOKIE } from "./session";
import { encodeBase64Url } from "./signed-cookie";

const origin = "https://heed.test";
const localOrigin = "http://localhost:8787";
const bindings = {
  ...env,
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  SESSION_SECRET: "test-session-secret",
  ALLOWED_EMAILS: " one@example.test, MEMBER@EXAMPLE.TEST ",
  DEV_LOGIN_EMAIL: "developer@example.test",
};
const oauthCookie = "__Host-heed_oauth";
const encoder = new TextEncoder();
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
let keyPair: CryptoKeyPair;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      ...algorithm,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(path: string, init?: RequestInit) {
  return worker.fetch(new Request(new URL(path, origin), init), bindings);
}

function getCookie(response: Response, name: string) {
  const cookie = response.headers
    .getAll("Set-Cookie")
    .find((entry) => entry.startsWith(`${name}=`));
  expect(cookie).toBeDefined();
  return cookie!;
}

async function beginLogin(query = "") {
  const response = await request("/auth/login" + query);
  expect(response.status).toBe(303);
  const authorization = new URL(response.headers.get("Location")!);
  const cookie = getCookie(response, oauthCookie);
  expect(cookie).toMatch(
    /Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax/,
  );
  const params = authorization.searchParams;
  expect(authorization.origin + authorization.pathname).toBe(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  expect(params.get("client_id")).toBe(bindings.GOOGLE_CLIENT_ID);
  expect(params.get("redirect_uri")).toBe(`${origin}/auth/callback`);
  expect(params.get("response_type")).toBe("code");
  expect(params.get("scope")).toBe("openid email");
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("state")).toMatch(/^[\w-]{43}$/);
  return { params, cookie: cookie.split(";")[0] };
}

async function mockGoogle(overrides: object = {}, badSignature = false) {
  const header = { alg: "RS256", kid: "test-key" };
  const claims = {
    iss: "https://accounts.google.com",
    aud: bindings.GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "member@example.test",
    email_verified: true,
    ...overrides,
  };
  const tokenBody = [header, claims]
    .map((part) => encodeBase64Url(encoder.encode(JSON.stringify(part))))
    .join(".");
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      algorithm,
      keyPair.privateKey,
      encoder.encode(tokenBody),
    ),
  );
  if (badSignature) signature[0] ^= 1;
  const token = `${tokenBody}.${encodeBase64Url(signature)}`;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({ id_token: token });
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return Response.json({ keys: [{ ...jwk, kid: header.kid }] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callback(
  login: Awaited<ReturnType<typeof beginLogin>>,
  state = login.params.get("state"),
) {
  return request(`/auth/callback?code=google-code&state=${state}`, {
    headers: { Cookie: login.cookie },
  });
}

async function devSession() {
  const response = await request(`${localOrigin}/auth/dev-login`);
  expect(response.status).toBe(303);
  return getCookie(response, SESSION_COOKIE).split(";")[0];
}

it("exchanges the Google code with PKCE and issues a sliding session", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const login = await beginLogin();
  const google = await mockGoogle();
  const response = await callback(login);

  expect(google).toHaveBeenCalledTimes(2);
  expect(google).toHaveBeenNthCalledWith(
    1,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      redirect: "manual",
      body: expect.any(URLSearchParams),
    },
  );
  const body = google.mock.calls[0][1]?.body as URLSearchParams;
  const verifier = body.get("code_verifier")!;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  expect(encodeBase64Url(new Uint8Array(digest))).toBe(
    login.params.get("code_challenge"),
  );
  expect(Object.fromEntries(body)).toEqual({
    client_id: bindings.GOOGLE_CLIENT_ID,
    client_secret: bindings.GOOGLE_CLIENT_SECRET,
    grant_type: "authorization_code",
    redirect_uri: `${origin}/auth/callback`,
    code: "google-code",
    code_verifier: verifier,
  });

  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/");
  expect(getCookie(response, oauthCookie)).toContain("Max-Age=0");
  const session = getCookie(response, SESSION_COOKIE);
  expect(session).toMatch(
    /Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax/,
  );

  const day = 24 * 60 * 60 * 1000;
  clock.mockReturnValue(now + 29 * day);
  const me = await request("/api/me", {
    headers: { Cookie: session.split(";")[0] },
  });
  expect(me.status).toBe(200);
  expect(me.headers.get("Cache-Control")).toBe("no-store");
  expect(await me.json()).toEqual({
    email: "member@example.test",
    workspaceId: "default",
  });
  const refreshed = getCookie(me, SESSION_COOKIE);
  expect(refreshed).not.toBe(session);

  clock.mockReturnValue(now + 30 * day);
  expect(
    (await request("/api/me", { headers: { Cookie: session.split(";")[0] } }))
      .status,
  ).toBe(401);
  expect(
    (await request("/api/me", { headers: { Cookie: refreshed.split(";")[0] } }))
      .status,
  ).toBe(200);
  expect(google).toHaveBeenCalledTimes(2);
});

it.each([
  ["wrong audience", { aud: "another-client" }],
  ["wrong issuer", { iss: "https://other.example" }],
  ["expired ID token", { exp: 0 }],
  ["unverified email", { email_verified: false }],
  ["email outside the allowlist", { email: "unlisted@example.test" }],
])("denies sign-in with %s", async (_description, claims) => {
  const login = await beginLogin();
  await mockGoogle(claims);
  const response = await callback(login);

  expect(response.status).toBe(403);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toContain("Access denied");
  expect(response.headers.getAll("Set-Cookie")).toEqual([
    expect.stringContaining(`${oauthCookie}=; Max-Age=0`),
  ]);
});

it("rejects an ID token with a bad signature", async () => {
  const login = await beginLogin();
  await mockGoogle({}, true);

  expect((await callback(login)).status).toBe(403);
});

it("rejects mismatched, missing, and expired OAuth state before calling Google", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const login = await beginLogin();
  const google = await mockGoogle();

  expect((await callback(login, "wrong-state")).status).toBe(400);
  expect((await callback({ ...login, cookie: "" })).status).toBe(400);
  clock.mockReturnValue(now + 10 * 60 * 1000);
  expect((await callback(login)).status).toBe(400);
  expect(google).not.toHaveBeenCalled();
});

it("rejects missing and tampered session cookies", async () => {
  const session = await devSession();
  const tampered = session.replace(
    /\.(.)/,
    (_, first: string) => `.${first === "A" ? "B" : "A"}`,
  );

  expect((await request("/api/me")).status).toBe(401);
  expect(
    (await request("/api/me", { headers: { Cookie: tampered } })).status,
  ).toBe(401);
});

it.each([undefined, "https://foreign.test", "http://localhost:8790", "null"])(
  "rejects WebSocket upgrades and API writes with Origin %s",
  async (originHeader) => {
    const headers = new Headers({ Cookie: await devSession() });
    if (originHeader) headers.set("Origin", originHeader);
    expect(
      (await request(`${localOrigin}/api/items`, { method: "POST", headers }))
        .status,
    ).toBe(403);
    headers.set("Upgrade", "websocket");
    expect((await request(`${localOrigin}/ws`, { headers })).status).toBe(403);
  },
);

it("requires a session with same-origin writes and upgrades, and exempts the agent routes", async () => {
  const headers = new Headers({ Origin: localOrigin });
  expect(
    (await request(`${localOrigin}/api/items`, { method: "POST", headers }))
      .status,
  ).toBe(401);
  headers.set("Upgrade", "websocket");
  expect((await request(`${localOrigin}/ws`, { headers })).status).toBe(401);
  headers.set("Cookie", await devSession());
  const upgrade = await request(`${localOrigin}/ws`, { headers });
  expect(upgrade.status).toBe(101);
  expect(getCookie(upgrade, SESSION_COOKIE)).toBeDefined();
  const socket = upgrade.webSocket!;
  socket.accept();
  socket.close(1000);
  headers.delete("Upgrade");
  expect(
    (await request(`${localOrigin}/api/items`, { method: "POST", headers }))
      .status,
  ).toBe(400);
  expect((await request("/api/report", { method: "POST" })).status).toBe(401);
  expect((await request("/mcp", { method: "POST" })).status).toBe(401);
});

it("only enables dev login on localhost with an explicitly configured email", async () => {
  const signedOut = await request(`${localOrigin}/api/me`);
  expect(signedOut.status).toBe(401);
  expect(await signedOut.json()).toMatchObject({ devLoginEnabled: true });
  expect(await (await request("/api/me")).json()).toMatchObject({
    devLoginEnabled: false,
  });

  const session = await devSession();
  const me = await request(`${localOrigin}/api/me`, {
    headers: { Cookie: session },
  });
  expect(await me.json()).toEqual({
    email: bindings.DEV_LOGIN_EMAIL,
    workspaceId: "default",
  });

  const deployed = await request("/auth/dev-login", {
    headers: { Host: "localhost", "X-Forwarded-Host": "localhost" },
  });
  expect(deployed.status).toBe(404);
  expect(deployed.headers.has("Set-Cookie")).toBe(false);
  const disabled = await worker.fetch(
    new Request(`${localOrigin}/auth/dev-login`),
    {
      ...bindings,
      DEV_LOGIN_EMAIL: undefined,
    },
  );
  expect(disabled.status).toBe(404);
});

it("requires a same-origin POST to clear the session cookie", async () => {
  expect((await request("/auth/logout")).status).toBe(404);
  expect((await request("/auth/logout", { method: "POST" })).status).toBe(403);
  const response = await request("/auth/logout", {
    method: "POST",
    headers: { Origin: origin, Cookie: await devSession() },
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/");
  expect(getCookie(response, SESSION_COOKIE)).toBe(
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
});

it("returns to the notified item after sign-in", async () => {
  const item = "7be25709bbbb41bc";
  const login = await beginLogin(`?item=${item}`);
  await mockGoogle();
  const response = await callback(login);
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe(`/?item=${item}`);
});

it("restricts development sign-in links to local item destinations", async () => {
  const response = await request(
    `${localOrigin}/auth/dev-login?item=//outside.example`,
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/");
});
