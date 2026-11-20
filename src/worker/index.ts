import { ReportProgressSchema } from "../shared/item-operations";
import { requireAgent } from "./agent-auth";
import type { AgentAuthEnv } from "./agent-auth";
import { handleAuth } from "./auth";
import type { AuthEnv } from "./auth";
import { requireSession } from "./session";
import type { HumanActor } from "./session";
import { handleTokenBootstrap } from "./token-admin";
import type { TokenAdminEnv } from "./token-admin";

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

    if (request.method === "POST" && pathname === "/api/admin/tokens") {
      return handleTokenBootstrap(request, env);
    }

    if (request.method === "POST" && pathname === "/api/report") {
      return requireAgent(request, env, async (actor, workspace) => {
        const input = ReportProgressSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!input.success) {
          return Response.json(
            { error: input.error.issues[0].message },
            { status: 400 },
          );
        }
        try {
          return Response.json(
            await workspace.reportProgress(actor, input.data),
          );
        } catch (error) {
          if (error instanceof Error) {
            if (error.message === "Item not found") {
              return Response.json({ error: error.message }, { status: 404 });
            }
            if (error.message.startsWith("Use reopenItem")) {
              return Response.json({ error: error.message }, { status: 409 });
            }
          }
          throw error;
        }
      });
    }

    if (pathname === "/mcp") {
      return requireAgent(
        request,
        env,
        () => new Response("Not found", { status: 404 }),
      );
    }

    if (pathname === "/ws" || pathname.startsWith("/api/")) {
      return requireSession(request, url, env.SESSION_SECRET, (actor) =>
        handleHumanRoute(request, url, actor),
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env & AgentAuthEnv & AuthEnv & TokenAdminEnv>;
