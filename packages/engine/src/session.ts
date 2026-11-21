import { apiError, limitResponse } from "./api-response.js";
import { checkLimit, LimitError } from "./seams.js";
import type { AuthProvider, Limits, WorkspaceSession } from "./seams.js";

export interface HumanActor extends WorkspaceSession {
  kind: "human";
}

export function hasAppOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

export async function requireSession(
  request: Request,
  url: URL,
  auth: AuthProvider,
  limits: Limits,
  handle: (actor: HumanActor) => Response | Promise<Response>,
): Promise<Response> {
  const isApi = url.pathname.startsWith("/api/");
  const reads = ["GET", "HEAD", "OPTIONS"];
  if (
    (url.pathname === "/ws" || !reads.includes(request.method)) &&
    !hasAppOrigin(request, url)
  ) {
    if (isApi) return apiError(403, "forbidden_origin", "Forbidden origin");
    return new Response("Forbidden origin", { status: 403 });
  }

  const session = await auth.session(request);
  if (!session) {
    if (isApi) return apiError(401, "unauthorized", "Unauthorized");
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    await checkLimit(limits, session.workspaceId, "connect");
    const response = await handle({ kind: "human", ...session });
    if (!response.ok && response.status !== 101) return response;
    const privateResponse = new Response(response.body, response);
    privateResponse.headers.set("Cache-Control", "no-store");
    return privateResponse;
  } catch (error) {
    if (error instanceof LimitError) return limitResponse(error);
    throw error;
  }
}
