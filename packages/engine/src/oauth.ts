import { CreateTokenSchema } from "@heedwork/core";
import type { AppContext } from "./app.js";
import { readBearer } from "./agent-auth.js";
import { consentPage } from "./oauth-consent.js";
import { CONSENT_SECONDS } from "./oauth-storage.js";
import type {
  OAuthAuthorization,
  OAuthClient,
  OAuthExchange,
} from "./oauth-storage.js";
import { checkLimit } from "./seams.js";
import { hasAppOrigin } from "./session.js";
import type { HumanActor } from "./session.js";
import {
  hashSecret,
  isTokenSecret,
  newTokenSecret,
  tokenParts,
} from "./token-secrets.js";

const MCP_RESOURCE_METADATA = "/.well-known/oauth-protected-resource/mcp";
const ROOT_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";
const SERVER_METADATA = "/.well-known/oauth-authorization-server";
const MCP_AUTHORIZE = "/auth/mcp/authorize";
const REGISTER = "/auth/mcp/register";
const TOKEN = "/auth/mcp/token";
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;
const SCOPES = ["report", "steer"];
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const OAUTH_ROUTES = new Set([
  MCP_RESOURCE_METADATA,
  ROOT_RESOURCE_METADATA,
  SERVER_METADATA,
  MCP_AUTHORIZE,
  REGISTER,
  TOKEN,
]);

function secureOAuthUrl(url: URL) {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
  );
}

export function mcpChallenge(request: Request, insufficientScope = false) {
  const metadata = new URL(MCP_RESOURCE_METADATA, request.url).href;
  const token = readBearer(request);
  const error = insufficientScope
    ? ', error="insufficient_scope"'
    : token
      ? ', error="invalid_token"'
      : "";
  return `Bearer resource_metadata="${metadata}", scope="${insufficientScope ? "steer" : "report"}"${error}`;
}

function oauthJson(value: object, status = 200, headers?: HeadersInit) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });
}

function oauthError(error: string, status = 400) {
  return oauthJson(
    { error },
    status,
    status === 401
      ? { "WWW-Authenticate": 'Basic realm="Heed OAuth"' }
      : undefined,
  );
}

function redirect(location: string, cookie?: string) {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function authorizationResponse(
  auth: Pick<OAuthAuthorization, "redirectUri" | "state">,
  issuer: string,
  result: { code: string } | { error: string },
  cookie?: string,
) {
  const target = new URL(auth.redirectUri);
  for (const key of ["code", "error", "state", "iss"])
    target.searchParams.delete(key);
  for (const [key, value] of Object.entries(result))
    target.searchParams.set(key, value);
  if (auth.state !== null) target.searchParams.set("state", auth.state);
  target.searchParams.set("iss", issuer);
  return redirect(target.href, cookie);
}

async function readBody(request: Request, type: string) {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
    type
  )
    return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let size = 0;
  let body = "";
  try {
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      size += chunk.value.byteLength;
      if (size > 16_384) return null;
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function uniqueParams(params: URLSearchParams) {
  return new Set(params.keys()).size === [...params.keys()].length;
}

async function formParams(request: Request) {
  const body = await readBody(request, "application/x-www-form-urlencoded");
  if (body === null) return null;
  const params = new URLSearchParams(body);
  return uniqueParams(params) ? params : null;
}

function validRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1024 || /[#\\\s]/.test(value))
    return false;
  const url = URL.canParse(value) && new URL(value);
  return !!url && !url.username && !url.password && secureOAuthUrl(url);
}

function registry(app: AppContext, issuer: string) {
  // Dynamic registration happens before a browser session identifies a workspace.
  return app.workspace(`oauth-client-registry:${issuer}`);
}

async function register(request: Request, issuer: string, app: AppContext) {
  const body = await readBody(request, "application/json");
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return oauthError("invalid_client_metadata");
    metadata = parsed as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata");
  }

  const { redirect_uris, client_name, scope } = metadata;
  const {
    token_endpoint_auth_method = "client_secret_basic",
    grant_types = ["authorization_code"],
    response_types = ["code"],
  } = metadata;
  if (
    !Array.isArray(redirect_uris) ||
    redirect_uris.length === 0 ||
    redirect_uris.length > 10 ||
    !redirect_uris.every(validRedirect)
  )
    return oauthError("invalid_redirect_uri");
  if (
    (client_name !== undefined &&
      (typeof client_name !== "string" ||
        !client_name.trim() ||
        client_name.length > 200 ||
        /[\p{Cc}\p{Cf}]/u.test(client_name))) ||
    !AUTH_METHODS.some((method) => method === token_endpoint_auth_method) ||
    !Array.isArray(grant_types) ||
    !grant_types.includes("authorization_code") ||
    !grant_types.every((type) => GRANT_TYPES.includes(type)) ||
    !Array.isArray(response_types) ||
    response_types.length !== 1 ||
    response_types[0] !== "code" ||
    (scope !== undefined &&
      (typeof scope !== "string" ||
        !scope.split(" ").every((value) => SCOPES.includes(value))))
  )
    return oauthError("invalid_client_metadata");

  const authMethod = token_endpoint_auth_method as OAuthClient["authMethod"];
  const secret = authMethod === "none" ? null : newTokenSecret();
  const client: OAuthClient = {
    id: newTokenSecret(),
    name:
      typeof client_name === "string"
        ? client_name.trim()
        : new URL(redirect_uris[0]).hostname,
    redirectUris: redirect_uris,
    authMethod,
    secretHash: secret === null ? null : await hashSecret(secret),
    refresh: grant_types.includes("refresh_token"),
  };
  await registry(app, issuer).registerOAuthClient(client);
  return oauthJson(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      ...(secret !== null && {
        client_secret: secret,
        client_secret_expires_at: 0,
      }),
      redirect_uris,
      token_endpoint_auth_method: authMethod,
      grant_types,
      response_types,
      ...(scope !== undefined && { scope }),
    },
    201,
  );
}

function consentCookie(csrf: string, maxAge: number) {
  return `__Host-heed_consent_${csrf.slice(0, 16)}=${maxAge ? csrf : ""}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function authorizationError(error: string, status = 400) {
  // Public registration does not prove control of a callback. Redirect only
  // after the user sees the destination and approves or cancels consent.
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function authorize(request: Request, url: URL, app: AppContext) {
  const resource = url.origin + "/mcp";
  if (request.method === "POST") {
    if (!hasAppOrigin(request, url))
      return authorizationError("invalid_request", 403);
    const session = await app.auth.session(request);
    if (!session) return authorizationError("access_denied", 403);
    const params = await formParams(request);
    const csrf = params?.get("csrf") ?? "";
    const cookie = consentCookie(csrf, CONSENT_SECONDS).split(";")[0];
    if (
      !isTokenSecret(csrf) ||
      !request.headers
        .get("Cookie")
        ?.split(";")
        .some((entry) => entry.trim() === cookie)
    )
      return authorizationError("invalid_request", 403);
    const decision = params?.get("decision");
    const input = CreateTokenSchema.safeParse({
      label: params?.get("label"),
      scope: params?.get("scope"),
    });
    if (decision !== "deny" && (decision !== "approve" || !input.success))
      return authorizationError("invalid_request");
    await checkLimit(app.limits, session.workspaceId, "connect");
    if (decision === "approve")
      await checkLimit(app.limits, session.workspaceId, "token.create");
    const result = await app
      .workspace(session.workspaceId)
      .finishOAuthConsent(
        csrf,
        session.user.id,
        resource,
        decision === "approve" && input.success
          ? { label: input.data.label, scope: input.data.scope }
          : null,
      );
    if (!result) return authorizationError("invalid_request", 403);
    return authorizationResponse(
      result.authorization,
      url.origin,
      result.code ? { code: result.code } : { error: "access_denied" },
      consentCookie(csrf, 0),
    );
  }

  if (request.method !== "GET") return methodNotAllowed("GET, POST");
  if (url.search.length > 2000 || !uniqueParams(url.searchParams))
    return authorizationError("invalid_request");
  const clientId = url.searchParams.get("client_id") ?? "";
  if (!isTokenSecret(clientId)) return authorizationError("invalid_client");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!validRedirect(redirectUri)) return authorizationError("invalid_request");
  const client = await registry(app, url.origin).findOAuthClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri))
    return authorizationError("invalid_request");
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge") ?? "";
  if (url.searchParams.get("response_type") !== "code")
    return authorizationError("unsupported_response_type");
  if (
    !isTokenSecret(challenge) ||
    url.searchParams.get("code_challenge_method") !== "S256"
  )
    return authorizationError("invalid_request");
  const requestedResource = url.searchParams.get("resource");
  if (requestedResource !== null && requestedResource !== resource)
    return authorizationError("invalid_target");
  const scope = url.searchParams.get("scope");
  if (
    scope !== null &&
    !scope.split(" ").every((value) => SCOPES.includes(value))
  )
    return authorizationError("invalid_scope");

  const session = await app.auth.session(request);
  if (!session) {
    const returnTo = url.pathname + url.search;
    return (
      app.auth.signIn?.(request, returnTo) ??
      redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`)
    );
  }
  await checkLimit(app.limits, session.workspaceId, "connect");
  const csrf = newTokenSecret();
  const { id, name, authMethod, secretHash, refresh } = client;
  await app
    .workspace(session.workspaceId)
    .beginOAuthConsent(csrf, session.user.id, {
      client: { id, name, authMethod, secretHash, refresh },
      redirectUri,
      state,
      challenge,
      resource,
    });
  const response = consentPage(name, redirectUri, session.workspaceId, csrf);
  response.headers.set("Set-Cookie", consentCookie(csrf, CONSENT_SECONDS));
  return response;
}

function clientCredentials(request: Request, params: URLSearchParams) {
  const authorization = request.headers.get("Authorization");
  const postedId = params.get("client_id");
  const postedSecret = params.get("client_secret");
  if (authorization !== null) {
    const basic = /^Basic +([A-Za-z0-9+/]+=*)$/i.exec(authorization);
    if (!basic || postedSecret !== null) return null;
    try {
      const pair = atob(basic[1]);
      const separator = pair.indexOf(":");
      if (separator < 0) return null;
      const id = decodeURIComponent(
        pair.slice(0, separator).replace(/\+/g, " "),
      );
      if (postedId !== null && postedId !== id) return null;
      return {
        id,
        secret: decodeURIComponent(
          pair.slice(separator + 1).replace(/\+/g, " "),
        ),
        method: "client_secret_basic",
      } as const;
    } catch {
      return null;
    }
  }
  return {
    id: postedId,
    secret: postedSecret,
    method: postedSecret === null ? "none" : "client_secret_post",
  } as const;
}

async function tokens(request: Request, url: URL, app: AppContext) {
  const params = await formParams(request);
  if (!params) return oauthError("invalid_request");
  const grantType = params.get("grant_type");
  if (!grantType) return oauthError("invalid_request");
  if (!GRANT_TYPES.includes(grantType))
    return oauthError("unsupported_grant_type");
  const credentials = clientCredentials(request, params);
  if (
    !credentials?.id ||
    !isTokenSecret(credentials.id) ||
    (credentials.secret !== null && !isTokenSecret(credentials.secret))
  )
    return oauthError(
      "invalid_client",
      request.headers.has("Authorization") ? 401 : 400,
    );

  const resource = url.origin + "/mcp";
  const requestedResource = params.get("resource");
  if (requestedResource !== null && requestedResource !== resource)
    return oauthError("invalid_target");
  let parts;
  let grant: OAuthExchange["grant"];
  if (grantType === "authorization_code") {
    const verifier = params.get("code_verifier") ?? "";
    const redirectUri = params.get("redirect_uri");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || redirectUri === null)
      return oauthError("invalid_grant");
    parts = tokenParts(params.get("code") ?? "", "heed-code_");
    grant = {
      type: "code",
      redirectUri,
      challenge: await hashSecret(verifier),
    };
  } else {
    parts = tokenParts(params.get("refresh_token") ?? "", "heed-refresh_");
    grant = { type: "refresh", scope: params.get("scope") };
  }
  if (!parts) return oauthError("invalid_grant");
  // Host routing uses the same workspace envelope as an access token.
  const workspaceId = await app.auth.workspaceForToken(
    `heed_${parts.workspaceId}_${parts.secret}`,
  );
  if (!workspaceId) return oauthError("invalid_grant");
  const result = await app.workspace(workspaceId).exchangeOAuthToken({
    grant,
    resource,
    secret: parts.secret,
    clientId: credentials.id,
    authMethod: credentials.method,
    clientSecretHash:
      credentials.secret === null ? null : await hashSecret(credentials.secret),
  });
  if ("error" in result)
    return oauthError(
      result.error,
      result.error === "invalid_client" && request.headers.has("Authorization")
        ? 401
        : 400,
    );
  return oauthJson(result);
}

function methodNotAllowed(allow: string) {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}

export async function issueAssistantToken(
  url: URL,
  { workspaceId, user }: HumanActor,
  app: AppContext,
) {
  const access = await app
    .workspace(workspaceId)
    .issueAssistantAccessToken(new URL("/mcp", url).href, user);
  return Response.json({
    ...access,
    workspace_id: workspaceId,
    user_id: user.id,
  });
}

export function handleOAuth(request: Request, url: URL, app: AppContext) {
  const { origin, pathname } = url;
  if (!OAUTH_ROUTES.has(pathname)) return;
  if (!secureOAuthUrl(url)) return authorizationError("invalid_request");
  switch (pathname) {
    case ROOT_RESOURCE_METADATA:
    case MCP_RESOURCE_METADATA:
      return request.method === "GET"
        ? oauthJson({
            resource: origin + "/mcp",
            authorization_servers: [origin],
            scopes_supported: SCOPES,
            bearer_methods_supported: ["header"],
          })
        : methodNotAllowed("GET");
    case SERVER_METADATA:
      return request.method === "GET"
        ? oauthJson({
            issuer: origin,
            authorization_endpoint: origin + MCP_AUTHORIZE,
            token_endpoint: origin + TOKEN,
            registration_endpoint: origin + REGISTER,
            response_types_supported: ["code"],
            grant_types_supported: GRANT_TYPES,
            scopes_supported: SCOPES,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: AUTH_METHODS,
            authorization_response_iss_parameter_supported: true,
          })
        : methodNotAllowed("GET");
    case MCP_AUTHORIZE:
      return authorize(request, url, app);
    case REGISTER:
    case TOKEN:
      if (request.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
        });
      if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS");
      return pathname === REGISTER
        ? register(request, origin, app)
        : tokens(request, url, app);
  }
}
