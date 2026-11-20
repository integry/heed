import { DEFAULT_WORKSPACE_ID } from "../shared/workspace";
import { apiError } from "./api-response";
import { readSignedCookie, signCookie } from "./signed-cookie";

export const SESSION_COOKIE = "__Host-heed_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export interface HumanActor {
  kind: "human";
  email: string;
  workspaceId: typeof DEFAULT_WORKSPACE_ID;
}

export function hasAppOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

export function issueSession(email: string, secret: string): Promise<string> {
  return signCookie(
    SESSION_COOKIE,
    { email, workspaceId: DEFAULT_WORKSPACE_ID },
    secret,
    SESSION_MAX_AGE,
  );
}

export async function requireSession(
  request: Request,
  url: URL,
  secret: string | undefined,
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

  const session =
    secret && (await readSignedCookie(request, SESSION_COOKIE, secret));
  if (
    !secret ||
    !session ||
    typeof session.email !== "string" ||
    !session.email ||
    session.workspaceId !== DEFAULT_WORKSPACE_ID
  ) {
    if (isApi) return apiError(401, "unauthorized", "Unauthorized");
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let response = await handle({
    kind: "human",
    email: session.email,
    workspaceId: session.workspaceId,
  });
  if (response.ok || response.status === 101) {
    // Copy the response to make its headers mutable while preserving an upgraded socket.
    response = new Response(response.body, response);
    response.headers.set("Cache-Control", "no-store");
    response.headers.append(
      "Set-Cookie",
      await issueSession(session.email, secret),
    );
  }
  return response;
}
