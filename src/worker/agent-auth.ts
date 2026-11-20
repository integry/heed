import { DEFAULT_WORKSPACE_ID } from "../shared/workspace";
import type { Actor } from "../shared/item-operations";
import { hashSecret, isTokenSecret } from "./token-secrets";
import { getWorkspaceStub } from "./workspace";

export interface AgentAuthEnv {
  TOKEN_RATE_LIMIT_PER_MINUTE?: string;
}

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_CAPACITY = 1_000_000;
const MAX_REQUESTS_PER_MINUTE = 1_000;

export function readBearer(request: Request): string | undefined {
  return /^Bearer +([^\s,]+)$/i.exec(
    request.headers.get("Authorization") ?? "",
  )?.[1];
}

export function bearerUnauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
  });
}

export async function requireAgent(
  request: Request,
  env: Env & AgentAuthEnv,
  handle: (
    actor: Extract<Actor, { kind: "agent" }>,
    workspace: ReturnType<typeof getWorkspaceStub>,
  ) => Response | Promise<Response>,
): Promise<Response> {
  // Self-hosted deployments have exactly one workspace.
  const prefix = `heed_${DEFAULT_WORKSPACE_ID}_`;
  const token = readBearer(request);
  if (!token?.startsWith(prefix)) return bearerUnauthorized();
  const secret = token.slice(prefix.length);
  if (!isTokenSecret(secret)) return bearerUnauthorized();

  const limit = Number(env.TOKEN_RATE_LIMIT_PER_MINUTE ?? 60);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_REQUESTS_PER_MINUTE
  ) {
    throw new Error(
      "TOKEN_RATE_LIMIT_PER_MINUTE must be an integer from 1 to 1000",
    );
  }
  // The binding threshold is static. Weight each request so the configured
  // number of requests reaches the threshold, with enough precision for rounding.
  const { success } = await env.TOKEN_RATE_LIMITER.limit({
    key: await hashSecret(token),
    delta: Math.ceil(RATE_LIMIT_CAPACITY / limit),
  });
  if (!success) {
    return new Response("Rate limit exceeded", {
      status: 429,
      headers: {
        "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
        "Cache-Control": "no-store",
      },
    });
  }

  const workspace = getWorkspaceStub(env, DEFAULT_WORKSPACE_ID);
  const actor = await workspace.verifyToken(secret);
  return actor ? handle(actor, workspace) : bearerUnauthorized();
}
