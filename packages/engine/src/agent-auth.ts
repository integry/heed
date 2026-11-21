import type { Actor } from "@heedwork/core";
import { limitResponse } from "./api-response.js";
import { checkLimit, LimitError } from "./seams.js";
import type { AppContext } from "./app.js";
import { tokenParts } from "./token-secrets.js";
import type { getWorkspaceStub } from "./workspace.js";

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
  { auth, limits, workspace: getWorkspace }: AppContext,
  handle: (
    actor: Extract<Actor, { kind: "agent" }>,
    workspace: ReturnType<typeof getWorkspaceStub>,
    workspaceId: string,
  ) => Response | Promise<Response>,
): Promise<Response> {
  const token = readBearer(request);
  const parts = token && tokenParts(token);
  if (!parts) return bearerUnauthorized();
  const workspaceId = await auth.workspaceForToken(token);
  if (!workspaceId) return bearerUnauthorized();

  try {
    await checkLimit(limits, workspaceId, "connect");
  } catch (error) {
    if (!(error instanceof LimitError)) throw error;
    if (error.code === "rate_limited") {
      return new Response(error.message, {
        status: error.status,
        headers: {
          "Retry-After": String(error.retryAfter),
          "Cache-Control": "no-store",
        },
      });
    }
    return limitResponse(error);
  }

  const workspace = getWorkspace(workspaceId);
  const actor = await workspace.verifyToken(parts.secret);
  return actor ? handle(actor, workspace, workspaceId) : bearerUnauthorized();
}
