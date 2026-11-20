import { readSignedCookie, signCookie } from "./signed-cookie";

export const SESSION_COOKIE = "__Host-heed_session";
export const WORKSPACE_ID = "default";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export interface HumanActor {
  kind: "human";
  email: string;
  workspaceId: typeof WORKSPACE_ID;
}

export function hasAppOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

export function issueSession(email: string, secret: string): Promise<string> {
  return signCookie(
    SESSION_COOKIE,
    { email, workspaceId: WORKSPACE_ID },
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
  const reads = ["GET", "HEAD", "OPTIONS"];
  if (
    (url.pathname === "/ws" || !reads.includes(request.method)) &&
    !hasAppOrigin(request, url)
  ) {
    return new Response("Forbidden origin", { status: 403 });
  }

  const session =
    secret && (await readSignedCookie(request, SESSION_COOKIE, secret));
  if (
    !secret ||
    !session ||
    typeof session.email !== "string" ||
    !session.email ||
    session.workspaceId !== WORKSPACE_ID
  ) {
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
    // A future workspace response can have immutable headers and carry the upgraded socket.
    response = new Response(response.body, response);
    response.headers.set("Cache-Control", "no-store");
    response.headers.append(
      "Set-Cookie",
      await issueSession(session.email, secret),
    );
  }
  return response;
}
