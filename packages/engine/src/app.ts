import { ReportProgressSchema } from "@heedwork/core";
import { apiError, limitResponse } from "./api-response.js";
import { requireAgent } from "./agent-auth.js";
import { handleHumanApi } from "./human-api.js";
import { handleMcp } from "./mcp.js";
import { requireSession } from "./session.js";
import { handleTokenBootstrap } from "./token-admin.js";
import type { TokenAdminEnv } from "./token-admin.js";
import { vapidKeys } from "./web-push.js";
import type { PushEnv } from "./web-push.js";
import type { Workspace } from "./workspace.js";
import { getWorkspaceStub, socketUpgrade } from "./workspace.js";
import { LimitError, recordUsage } from "./seams.js";
import type { AppSeams, WorkspaceSession } from "./seams.js";

export interface AppEnv extends TokenAdminEnv, PushEnv {
  WORKSPACE: DurableObjectNamespace<Workspace>;
}

export interface AppOptions<Bindings extends AppEnv = AppEnv> {
  /** Optional postprocessing for browser session responses, such as sliding cookies. */
  sessionResponse?(
    request: Request,
    response: Response,
    env: Bindings,
  ): Promise<Response>;
  /** Enable the admin-secret token bootstrap for this workspace. */
  bootstrapWorkspace?: string;
}

export interface SeamContext {
  request: Request;
  /** The resolved browser session, available when checking an authenticated action. */
  session(): WorkspaceSession | undefined;
  /** Returns the request's cached stub for the given workspace. */
  workspace(id: string): ReturnType<typeof getWorkspaceStub>;
}

export interface AppContext extends AppSeams, SeamContext {
  ctx: ExecutionContext;
}

/** Builds a Worker from seams or a factory for request-bound seams. */
export function createApp<Bindings extends AppEnv = AppEnv>(
  seams: AppSeams | ((env: Bindings, context: SeamContext) => AppSeams),
  options: AppOptions<Bindings> = {},
) {
  return {
    async fetch(
      request: Request,
      env: Bindings,
      ctx: ExecutionContext,
    ): Promise<Response> {
      try {
        return await route(request, env, ctx, seams, options);
      } catch (error) {
        if (error instanceof LimitError) return limitResponse(error);
        throw error;
      }
    },
  };
}

async function route<Bindings extends AppEnv>(
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
  seams: AppSeams | ((env: Bindings, context: SeamContext) => AppSeams),
  options: AppOptions<Bindings>,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/health") {
    return Response.json({ ok: true });
  }

  if (request.method === "GET" && pathname === "/api/push/key") {
    const vapid = vapidKeys(env);
    return vapid
      ? Response.json(
          { publicKey: vapid.publicKey },
          {
            headers: { "Cache-Control": "no-store" },
          },
        )
      : apiError(
          503,
          "push_unavailable",
          "Push notifications are not configured.",
        );
  }

  const stubs = new Map<string, ReturnType<typeof getWorkspaceStub>>();
  let session: WorkspaceSession | undefined;
  const scope = {
    request,
    session: () => session,
    workspace(id: string) {
      let stub = stubs.get(id);
      if (!stub) {
        stub = getWorkspaceStub(env, id);
        stubs.set(id, stub);
      }
      return stub;
    },
  };
  const app: AppContext = {
    ...scope,
    ...(typeof seams === "function" ? seams(env, scope) : seams),
    ctx,
  };

  if (pathname.startsWith("/auth/")) {
    return app.auth.handleAuthRoute(request);
  }

  if (request.method === "POST" && pathname === "/api/admin/tokens") {
    return handleTokenBootstrap(request, env, app, options.bootstrapWorkspace);
  }

  if (request.method === "POST" && pathname === "/api/report") {
    return requireAgent(request, app, async (actor, workspace, workspaceId) => {
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
        const result = await workspace.reportProgress(actor, input.data);
        recordUsage(ctx, app.usage, workspaceId, {
          type: "agent.write",
          operation: "report_progress",
        });
        return Response.json(result);
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
    return requireAgent(request, app, (actor, workspace, workspaceId) =>
      handleMcp(request, actor, workspace, workspaceId, app),
    );
  }

  if (pathname === "/ws") {
    const response = await requireSession(
      request,
      url,
      app.auth,
      app.limits,
      (actor) => {
        if (request.method !== "GET") {
          return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET" },
          });
        }
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected a WebSocket upgrade", { status: 426 });
        }
        return app
          .workspace(actor.workspaceId)
          .fetch(socketUpgrade(request, actor.user, actor.role));
      },
    );
    return options.sessionResponse?.(request, response, env) ?? response;
  }

  if (pathname.startsWith("/api/")) {
    const response = await requireSession(
      request,
      url,
      app.auth,
      app.limits,
      (actor) => {
        session = actor;
        return handleHumanApi(request, url, actor, env, app);
      },
    );
    return options.sessionResponse?.(request, response, env) ?? response;
  }

  return new Response("Not found", { status: 404 });
}
