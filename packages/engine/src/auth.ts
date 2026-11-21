import {
  clearCookie,
  decodeBase64Url,
  decodeJson,
  encodeBase64Url,
  readSignedCookie,
  signCookie,
} from "./signed-cookie.js";
import { DEFAULT_WORKSPACE_ID } from "@heedwork/core";
import { hasAppOrigin } from "./session.js";
import type { AuthProvider } from "./seams.js";
import { tokenParts } from "./token-secrets.js";

export const SESSION_COOKIE = "__Host-heed_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const verifiedSessions = new WeakMap<
  Request,
  { email: string; sessionId: string }
>();

export function issueSession(
  email: string,
  secret: string,
  sessionId: string = crypto.randomUUID(),
): Promise<string> {
  return signCookie(
    SESSION_COOKIE,
    { email, workspaceId: DEFAULT_WORKSPACE_ID, sessionId },
    secret,
    SESSION_MAX_AGE,
  );
}

/** Google and localhost sign-in for the self-hosted, single-workspace deployment. */
export function googleAllowlistAuth(env: AuthEnv): AuthProvider {
  return {
    async session(request) {
      const session =
        env.SESSION_SECRET &&
        (await readSignedCookie(request, SESSION_COOKIE, env.SESSION_SECRET));
      if (
        !session ||
        typeof session.email !== "string" ||
        !session.email ||
        session.workspaceId !== DEFAULT_WORKSPACE_ID
      )
        return null;
      const { email } = session;
      verifiedSessions.set(request, {
        email,
        sessionId:
          typeof session.sessionId === "string" ? session.sessionId : email,
      });
      return {
        user: { id: email, email, name: email },
        workspaceId: DEFAULT_WORKSPACE_ID,
        role: "owner",
      };
    },
    handleAuthRoute(request) {
      return handleAuth(request, new URL(request.url), env);
    },
    async workspaceForToken(token) {
      return tokenParts(token)?.workspaceId === DEFAULT_WORKSPACE_ID
        ? DEFAULT_WORKSPACE_ID
        : null;
    },
  };
}

export function openSessionId(request: Request) {
  return verifiedSessions.get(request)?.sessionId;
}

/** Sliding session cookies, the dev login hint and the self-hosted token bootstrap. */
export const openAuthOptions = {
  async sessionResponse(request: Request, response: Response, env: AuthEnv) {
    const session = verifiedSessions.get(request);
    if (
      session &&
      env.SESSION_SECRET &&
      (response.ok || response.status === 101)
    ) {
      response.headers.append(
        "Set-Cookie",
        await issueSession(
          session.email,
          env.SESSION_SECRET,
          session.sessionId,
        ),
      );
    }
    const url = new URL(request.url);
    if (
      response.status === 401 &&
      request.method === "GET" &&
      url.pathname === "/api/me"
    ) {
      return Response.json(
        {
          ...(await response.json<object>()),
          devLoginEnabled: Boolean(devLoginEmail(url, env)),
        },
        response,
      );
    }
    return response;
  },
  bootstrapWorkspace: DEFAULT_WORKSPACE_ID,
};

export interface AuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  ALLOWED_EMAILS?: string;
  DEV_LOGIN_EMAIL?: string;
}

const STATE_COOKIE = "__Host-heed_oauth";
const STATE_MAX_AGE = 10 * 60;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const encoder = new TextEncoder();

function redirect(location: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function signInError(status: number, title: string, message: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Heed</title>
  <style>
    body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #f2f5f0; color: #172b27; font-family: system-ui, sans-serif; }
    main { padding: 2rem; text-align: center; }
    h1 { margin: 0; font-size: clamp(2rem, 7vw, 3rem); letter-spacing: -0.04em; }
    p { margin: 0.75rem 0 1.25rem; color: #415b53; }
    a { color: #245448; text-underline-offset: 0.2em; }
  </style>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/auth/login">Try Google sign-in again</a>
  </main>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

function callbackUrl(url: URL): string {
  return new URL("/auth/callback", url.origin).href;
}

function itemId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value)
    ? value
    : undefined;
}

function itemDestination(value: unknown): string {
  const item = itemId(value);
  return item ? `/?item=${item}` : "/";
}

async function startLogin(
  url: URL,
  clientId: string,
  secret: string,
): Promise<Response> {
  const state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  const authorization = new URL(GOOGLE_AUTH_URL);
  authorization.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(url),
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: encodeBase64Url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  }).toString();

  return redirect(
    authorization.href,
    await signCookie(
      STATE_COOKIE,
      {
        state,
        verifier,
        origin: url.origin,
        item: itemId(url.searchParams.get("item")),
      },
      secret,
      STATE_MAX_AGE,
    ),
  );
}

async function verifiedGoogleEmail(
  token: string,
  clientId: string,
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJson(encodedHeader) as {
    alg?: unknown;
    kid?: unknown;
    crit?: unknown;
  } | null;
  if (
    header?.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.crit !== undefined
  ) {
    return null;
  }

  const response = await fetch(GOOGLE_JWKS_URL, { redirect: "manual" });
  if (!response.ok) throw new Error("Google JWKS request failed");
  const { keys } = await response.json<{
    keys: (JsonWebKey & { kid?: string })[];
  }>();
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) return null;
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, [
    "verify",
  ]);
  const valid = await crypto.subtle.verify(
    algorithm,
    key,
    decodeBase64Url(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedClaims}`),
  );
  if (!valid) return null;

  const claims = decodeJson(encodedClaims) as {
    iss?: unknown;
    aud?: unknown;
    exp?: unknown;
    email_verified?: unknown;
    email?: unknown;
  } | null;
  if (
    (claims?.iss !== "https://accounts.google.com" &&
      claims?.iss !== "accounts.google.com") ||
    claims.aud !== clientId ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= Math.floor(Date.now() / 1000) ||
    claims.email_verified !== true ||
    typeof claims.email !== "string"
  ) {
    return null;
  }
  return claims.email.toLowerCase();
}

async function finishLogin(
  request: Request,
  url: URL,
  clientId: string,
  clientSecret: string,
  secret: string,
  allowlist = "",
): Promise<Response> {
  const state = await readSignedCookie(request, STATE_COOKIE, secret);
  if (
    typeof state?.state !== "string" ||
    state.state !== url.searchParams.get("state") ||
    state.origin !== url.origin ||
    typeof state.verifier !== "string"
  ) {
    return signInError(
      400,
      "Sign-in could not be verified",
      "Start Google sign-in again.",
    );
  }

  const code = url.searchParams.get("code");
  let response: Response;
  if (!code || url.searchParams.has("error")) {
    response = signInError(
      400,
      "Sign-in was interrupted",
      "Start Google sign-in again.",
    );
  } else {
    try {
      const exchange = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          redirect_uri: callbackUrl(url),
          code,
          code_verifier: state.verifier,
        }),
      });
      if (!exchange.ok) throw new Error("Google token exchange failed");
      const { id_token: token } = await exchange.json<{ id_token?: unknown }>();
      const email =
        typeof token === "string"
          ? await verifiedGoogleEmail(token, clientId)
          : null;
      const allowed = allowlist
        .split(",")
        .map((entry) => entry.trim().toLowerCase());
      response =
        email && allowed.includes(email)
          ? redirect(
              itemDestination(state.item),
              await issueSession(email, secret),
            )
          : signInError(
              403,
              "Access denied",
              "This Google account isn't allowed to sign in to this workspace.",
            );
    } catch {
      response = signInError(
        502,
        "Google sign-in is unavailable",
        "Please try again.",
      );
    }
  }
  response.headers.append("Set-Cookie", clearCookie(STATE_COOKIE));
  return response;
}

function devLoginEmail(url: URL, env: AuthEnv): string | undefined {
  if (url.hostname === "localhost" && env.SESSION_SECRET) {
    return env.DEV_LOGIN_EMAIL?.trim().toLowerCase() || undefined;
  }
}

async function handleAuth(
  request: Request,
  url: URL,
  env: AuthEnv,
): Promise<Response> {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET } = env;
  const { pathname } = url;
  if (pathname === "/auth/logout" && request.method === "POST") {
    if (!hasAppOrigin(request, url)) {
      return new Response("Forbidden origin", { status: 403 });
    }
    return redirect("/", clearCookie(SESSION_COOKIE));
  }

  if (pathname === "/auth/dev-login" && request.method === "GET") {
    const email = devLoginEmail(url, env);
    if (email && SESSION_SECRET) {
      return redirect(
        itemDestination(url.searchParams.get("item")),
        await issueSession(email, SESSION_SECRET),
      );
    }
  }

  if (
    (pathname === "/auth/login" || pathname === "/auth/callback") &&
    request.method === "GET"
  ) {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET) {
      return signInError(
        503,
        "Sign-in is unavailable",
        "Google sign-in has not been configured for this workspace.",
      );
    }
    if (pathname === "/auth/login")
      return startLogin(url, GOOGLE_CLIENT_ID, SESSION_SECRET);
    return finishLogin(
      request,
      url,
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      SESSION_SECRET,
      env.ALLOWED_EMAILS,
    );
  }

  return new Response("Not found", { status: 404 });
}
