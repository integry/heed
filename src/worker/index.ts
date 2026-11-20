import { ReportProgressSchema } from "../shared/item-operations";
import { requireAgent } from "./agent-auth";
import type { AgentAuthEnv } from "./agent-auth";
import { handleAuth } from "./auth";
import type { AuthEnv } from "./auth";
import { handleHumanApi } from "./human-api";
import { handleMcp } from "./mcp";
import { requireSession } from "./session";
import { handleTokenBootstrap } from "./token-admin";
import type { TokenAdminEnv } from "./token-admin";
import { getWorkspaceStub } from "./workspace";

export { Workspace } from "./workspace";

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
      const origin = request.headers.get("Origin");
      if (origin !== null && origin !== url.origin) {
        return new Response("Invalid Origin", { status: 403 });
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      return requireAgent(request, env, (actor, workspace) =>
        handleMcp(request, actor, workspace),
      );
    }

    if (pathname === "/ws") {
      return requireSession(request, url, env.SESSION_SECRET, (actor) => {
        if (request.method !== "GET") {
          return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET" },
          });
        }
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected a WebSocket upgrade", { status: 426 });
        }
        return getWorkspaceStub(env, actor.workspaceId).fetch(request);
      });
    }

    if (pathname.startsWith("/api/")) {
      return requireSession(request, url, env.SESSION_SECRET, (actor) =>
        handleHumanApi(request, url, actor, env),
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env & AgentAuthEnv & AuthEnv & TokenAdminEnv>;
