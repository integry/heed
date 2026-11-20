import { handleAuth } from "./auth";
import type { AuthEnv } from "./auth";
import { requireSession } from "./session";
import type { HumanActor } from "./session";

export { Workspace } from "./workspace";

function handleHumanRoute(
  request: Request,
  url: URL,
  actor: HumanActor,
): Response {
  if (request.method === "GET" && url.pathname === "/api/me") {
    return Response.json({
      email: actor.email,
      workspaceId: actor.workspaceId,
    });
  }
  return new Response("Not found", { status: 404 });
}

export default {
  fetch(request: Request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "GET" && pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (pathname.startsWith("/auth/")) {
      return handleAuth(request, url, env);
    }

    const agentReport = request.method === "POST" && pathname === "/api/report";
    if (pathname === "/ws" || (pathname.startsWith("/api/") && !agentReport)) {
      return requireSession(request, url, env.SESSION_SECRET, (actor) =>
        handleHumanRoute(request, url, actor),
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env & AuthEnv>;
