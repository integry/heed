import type { ZodType } from "zod";
import {
  GuidanceBodySchema,
  HandoffBodySchema,
  HistoryQuerySchema,
  ReopenBodySchema,
  TimezoneBodySchema,
} from "../shared/human-api";
import {
  AddItemSchema,
  DependencyBodySchema,
  SetStatusBodySchema,
  UpdateItemSchema,
} from "../shared/item-operations";
import {
  CreateProjectSchema,
  CreateTokenSchema,
  UpdateProjectSchema,
} from "../shared/workspace";
import { apiError, workspaceOperationError } from "./api-response";
import type { HumanActor } from "./session";
import {
  PushEndpointSchema,
  PushSubscriptionSchema,
  vapidKeys,
} from "./web-push";
import type { PushEnv } from "./web-push";
import { getWorkspaceStub } from "./workspace";

const updateItemBodySchema = UpdateItemSchema.omit({ item_id: true });

async function withJson<T>(
  request: Request,
  schema: ZodType<T>,
  operation: (input: T) => unknown,
  status = 200,
): Promise<Response> {
  const input = schema.safeParse(await request.json().catch(() => undefined));
  if (!input.success) {
    return apiError(400, "invalid_input", input.error.issues[0].message);
  }
  return Response.json(await operation(input.data), { status });
}

export async function handleHumanApi(
  request: Request,
  url: URL,
  session: HumanActor,
  env: Env & PushEnv,
): Promise<Response> {
  const { method } = request;
  const { pathname } = url;
  if (method === "GET" && pathname === "/api/me") {
    return Response.json({
      email: session.email,
      workspaceId: session.workspaceId,
    });
  }

  const actor = { kind: "human" } as const;
  try {
    const workspace = getWorkspaceStub(env, session.workspaceId);
    switch (`${method} ${pathname}`) {
      case "POST /api/push/status":
        return await withJson(request, PushSubscriptionSchema, (input) =>
          workspace.getPushStatus(input),
        );
      case "POST /api/push/subscribe":
        if (!vapidKeys(env))
          return apiError(
            503,
            "push_unavailable",
            "Push notifications are not configured.",
          );
        return await withJson(request, PushSubscriptionSchema, (input) =>
          workspace.subscribePush(input),
        );
      case "DELETE /api/push/subscribe":
        return await withJson(request, PushEndpointSchema, (input) =>
          workspace.unsubscribePush(input),
        );
      case "POST /api/items":
        return await withJson(
          request,
          AddItemSchema,
          (input) => workspace.addItem(actor, input),
          201,
        );
      case "POST /api/dependencies":
      case "DELETE /api/dependencies":
        return await withJson(request, DependencyBodySchema, (input) =>
          workspace.setDependency(actor, {
            ...input,
            action: method === "POST" ? "add" : "remove",
          }),
        );
      case "GET /api/projects":
        return Response.json(await workspace.listProjects());
      case "POST /api/projects":
        return await withJson(
          request,
          CreateProjectSchema,
          (input) => workspace.createProject(input),
          201,
        );
      case "GET /api/settings":
        return Response.json(await workspace.getSettings());
      case "PUT /api/settings/timezone":
        return await withJson(
          request,
          TimezoneBodySchema,
          async ({ timezone }) => {
            await workspace.setTimezone(timezone);
            return { timezone };
          },
        );
      case "PUT /api/settings/guidance":
        return await withJson(request, GuidanceBodySchema, ({ text }) =>
          workspace.setGuidance(actor, text),
        );
      case "GET /api/tokens":
        return Response.json(await workspace.listTokens());
      case "POST /api/tokens":
        return await withJson(
          request,
          CreateTokenSchema,
          ({ label, scope, default_project_id }) =>
            workspace.createToken(label, scope, default_project_id),
          201,
        );
      case "GET /api/history": {
        const input = HistoryQuerySchema.safeParse(
          Object.fromEntries(url.searchParams),
        );
        if (!input.success) {
          return apiError(400, "invalid_input", input.error.issues[0].message);
        }
        return Response.json(await workspace.getHistory(input.data));
      }
    }

    const item =
      /^\/api\/items\/([^/]+)(?:\/(status|handoff|reopen|events))?$/.exec(
        pathname,
      );
    if (item) {
      const item_id = decodeURIComponent(item[1]);
      switch (`${method} ${item[2] ?? ""}`) {
        case "GET ":
          return Response.json(await workspace.getItem({ item_id }));
        case "PATCH ":
          return await withJson(request, updateItemBodySchema, (input) =>
            workspace.updateItem(actor, { ...input, item_id }),
          );
        case "DELETE ":
          return Response.json(await workspace.deleteItem(actor, { item_id }));
        case "POST status":
          return await withJson(request, SetStatusBodySchema, (input) =>
            workspace.reportProgress(actor, { ...input, item_id }),
          );
        case "POST handoff":
          return await withJson(request, HandoffBodySchema, (input) =>
            "clear" in input
              ? workspace.clearHandoff(actor, { item_id })
              : workspace.flagHandoff(actor, { ...input, item_id }),
          );
        case "POST reopen":
          return await withJson(request, ReopenBodySchema, (input) =>
            workspace.reopenItem(actor, { ...input, item_id }),
          );
        case "GET events":
          return Response.json(await workspace.getItemEvents({ item_id }));
      }
    }

    const project = /^\/api\/projects\/([^/]+)$/.exec(pathname);
    if (project && method === "PATCH") {
      const id = decodeURIComponent(project[1]);
      return await withJson(request, UpdateProjectSchema, (input) =>
        workspace.updateProject(id, input),
      );
    }
    if (project && method === "DELETE") {
      await workspace.deleteProject(decodeURIComponent(project[1]));
      return Response.json({ ok: true });
    }
    const token = /^\/api\/tokens\/([^/]+)$/.exec(pathname);
    if (token && method === "DELETE") {
      const revoked = await workspace.revokeToken(decodeURIComponent(token[1]));
      return revoked
        ? Response.json({ ok: true })
        : apiError(404, "not_found", "Token not found");
    }

    return apiError(404, "not_found", "Not found");
  } catch (error) {
    const { status, code, message } = workspaceOperationError(error);
    return apiError(status, code, message);
  }
}
