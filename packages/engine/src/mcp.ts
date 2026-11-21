import {
  createMcpHandler,
  isLegacyRequest,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  AddItemSchema,
  CanvasQuerySchema,
  FlagHandoffSchema,
  MAX_CANVAS_ITEMS,
  ReopenItemSchema,
  ReportProgressSchema,
  SetDependencySchema,
  SetGuidanceSchema,
  UpdateItemSchema,
} from "@heedwork/core";
import type { Actor, ItemOperationResult } from "@heedwork/core";
import type { getWorkspaceStub } from "./workspace.js";
import type { AppContext } from "./app.js";
import {
  checkLimit,
  LimitError,
  OpenPushAllowance,
  recordUsage,
} from "./seams.js";

const instructions =
  "Heed is the user's live view of everything they and their agents are working on. It only stays accurate if you report to it. Whenever you do work for the user: find or create the matching item, mark it active when you start, report after each meaningful step, and mark it done, blocked or flagged for handoff when you stop. Heed does not assign work — never pick up items from it on your own initiative. The user's current guidance follows; it decides where items go, how important they are and when the user may be interrupted. Follow it over your own judgement.";

const defaultGuidance =
  "Put new items in the backlog at priority 5. Notify the user only when you cannot continue at all.";

const MAX_TOOL_RESULT_BYTES = 128 * 1024;

type Agent = Extract<Actor, { kind: "agent" }>;
type WorkspaceStub = ReturnType<typeof getWorkspaceStub>;

function defineTool<T>(
  name: string,
  description: string,
  schema: z.ZodObject<z.ZodRawShape> & z.ZodType<T>,
  run: (
    workspace: WorkspaceStub,
    actor: Agent,
    input: T,
    pushCap: number | null,
  ) => Promise<Record<string, unknown>>,
  limit?: (input: T) => "item.create" | "push" | undefined,
) {
  const inputSchema = z.toJSONSchema(schema, { io: "input" });
  const definition: Tool = {
    name,
    description,
    inputSchema: inputSchema as Tool["inputSchema"],
  };
  return {
    definition,
    async call(
      workspace: WorkspaceStub,
      actor: Agent,
      args: unknown,
      workspaceId: string,
      app: AppContext,
    ) {
      const input = schema.safeParse(args ?? {});
      if (!input.success) {
        const { path, message } = input.error.issues[0];
        throw new Error(
          path.length ? `${path.join(".")}: ${message}` : message,
        );
      }
      const action = limit?.(input.data);
      const decision =
        action && (await checkLimit(app.limits, workspaceId, action));
      const pushCap =
        decision instanceof OpenPushAllowance ? decision.cap : null;
      const result = await run(workspace, actor, input.data, pushCap);
      if (name !== "get_canvas")
        recordUsage(app.ctx, app.usage, workspaceId, {
          type: "agent.write",
          operation: name,
        });
      return result;
    },
  };
}

function itemResult({
  item_id,
  ignored_fields,
  guidance_updated_at,
}: ItemOperationResult) {
  return { item_id, ignored_fields, guidance_updated_at };
}

const tools = [
  defineTool(
    "get_canvas",
    `Call before creating an item or when you need an ID to report against. Filter by project, parent or title to find matching work and avoid duplicates. Use parent_id: null to find top-level items. Include completed items when looking up past work. The default limit is 50 and the maximum is ${MAX_CANVAS_ITEMS}. Re-read the current guidance here when guidance_updated_at changes. Use Heed to report on work the user assigned.`,
    CanvasQuerySchema,
    async (workspace, _actor, input) => ({
      ...(await workspace.getCanvas(input)),
    }),
  ),
  defineTool(
    "add_item",
    "Add work to the user's view. Use it when you start something that has no item yet, when you split a task into parts (pass parent_id), or when you discover follow-up work that should not be forgotten (leave it in the backlog). Call get_canvas first to avoid duplicates, and pass external_key (PR URL or repo#branch) so retries update the same item.",
    AddItemSchema,
    async (workspace, actor, input) =>
      itemResult(await workspace.addItem(actor, input)),
    () => "item.create",
  ),
  defineTool(
    "report_progress",
    'Tell the user what you are working on. Call this (1) when you start work, with status "active"; (2) after each meaningful step, or at least every 10 minutes during long work, with a one-line note; (3) when you finish, with status "done" and the PR or issue link as ref_url; (4) when you cannot continue, with status "blocked" and the reason. If no item exists for the work yet, call add_item first. Always pass a stable agent_name.',
    ReportProgressSchema,
    async (workspace, actor, input) =>
      itemResult(await workspace.reportProgress(actor, input)),
  ),
  defineTool(
    "update_item",
    "Use when the details or placement of an existing item change. Pass only the fields you intend to edit and follow the user's guidance for placement. Check ignored_fields for edits the user's locks prevented. Changing project, visibility, sort order, layout position or field locks requires a steer token.",
    UpdateItemSchema,
    async (workspace, actor, input) =>
      itemResult(await workspace.updateItem(actor, input)),
  ),
  defineTool(
    "set_dependency",
    "Add a dependency when an item must wait for another item. Pass the waiting item as item_id and its prerequisite as blocked_by_id. Remove the edge when the prerequisite no longer applies.",
    SetDependencySchema,
    async (workspace, actor, input) => {
      const result = await workspace.setDependency(actor, input);
      return { ...itemResult(result), dependency: result.dependency };
    },
  ),
  defineTool(
    "flag_handoff",
    "Use when the user must decide or provide something before the work can continue or be trusted: a decision, a review, a credential, a manual step. Say exactly what you need in the note, phrased so it can be answered in one line. Set notify to true only if the user's guidance says this kind of thing is worth interrupting them for; a notification reaches their phone immediately. When in doubt, flag without notifying.",
    FlagHandoffSchema,
    async (workspace, actor, input, pushCap) => {
      const result = await workspace.flagHandoff(actor, input, pushCap);
      const { notification } = result;
      return {
        ...itemResult(result),
        ...(notification && { notification }),
        ...(notification === "rate_limited" && {
          message:
            "Handoff flagged. No push sent because this token reached its hourly push limit.",
        }),
      };
    },
    (input) => (input.notify === true ? "push" : undefined),
  ),
  defineTool(
    "reopen_item",
    "Use when a regression or follow-up brings a done or cancelled item back into scope. Find the original item with get_canvas and include_done, then give a short reason for reopening it.",
    ReopenItemSchema,
    async (workspace, actor, input) =>
      itemResult(await workspace.reopenItem(actor, input)),
  ),
  defineTool(
    "set_guidance",
    "Use only when the user explicitly changes their standing instructions for placement, priority or notifications. Send the full replacement text, keeping any guidance the user wants to retain. This requires a steer token.",
    SetGuidanceSchema,
    async (workspace, actor, { text }) => ({
      ...(await workspace.setGuidance(actor, text)),
    }),
  ),
];

function toolResult(
  data: Record<string, unknown>,
  isError = false,
): CallToolResult {
  let text = JSON.stringify(data);
  if (new TextEncoder().encode(text).byteLength > MAX_TOOL_RESULT_BYTES) {
    data = {
      error:
        "Canvas result is too large. Narrow the filters or lower the limit.",
      guidance_updated_at: data.guidance_updated_at,
    };
    isError = true;
    text = JSON.stringify(data);
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
    ...(isError && { isError }),
  };
}

class HeedMcpServer extends Server {
  constructor(private readonly workspace: WorkspaceStub) {
    super({ name: "heed", version: "0.1.0" }, { capabilities: { tools: {} } });
  }

  // Keep the SDK's version negotiation and read guidance only for discovery.
  protected override _wrapHandler(...args: Parameters<Server["_wrapHandler"]>) {
    const [method] = args;
    const handle = super._wrapHandler(...args);
    if (method !== "initialize" && method !== "server/discover") return handle;
    return async (...call: Parameters<typeof handle>) => {
      const result = await handle(...call);
      const { guidance } = await this.workspace.getGuidance();
      return {
        ...result,
        instructions: `${instructions}\n\n${guidance || defaultGuidance}`,
      };
    };
  }
}

function createServer(
  actor: Agent,
  workspace: WorkspaceStub,
  workspaceId: string,
  app: AppContext,
) {
  const server = new HeedMcpServer(workspace);
  server.setRequestHandler("tools/list", () => ({
    tools: tools.map(({ definition }) => definition),
  }));
  server.setRequestHandler("tools/call", async ({ params }) => {
    const tool = tools.find(
      ({ definition }) => definition.name === params.name,
    );
    try {
      if (!tool)
        throw new Error(
          "Unknown tool. Call tools/list to see the available tools.",
        );
      return toolResult(
        await tool.call(workspace, actor, params.arguments, workspaceId, app),
      );
    } catch (error) {
      if (error instanceof LimitError)
        return toolResult(
          {
            error: `${error.action}: ${error.message}`.slice(0, 1_000),
            limit: error.action,
          },
          true,
        );
      let message =
        error instanceof Error ? error.message : "The operation failed.";
      if (message === "Item not found") {
        message =
          "Item not found. Call get_canvas to find an item ID, or add_item if the work has no item yet.";
      }
      const { guidance_updated_at } = await workspace.getGuidance();
      return toolResult(
        {
          error: message
            .replace("Use reopenItem", "Use reopen_item")
            .slice(0, 1_000),
          guidance_updated_at,
        },
        true,
      );
    }
  });
  return server;
}

export async function handleMcp(
  request: Request,
  actor: Agent,
  workspace: WorkspaceStub,
  workspaceId: string,
  app: AppContext,
) {
  // The SDK's built-in compatibility fallback uses SSE for 2025 requests.
  if (!(await isLegacyRequest(request))) {
    const handler = createMcpHandler(
      () => createServer(actor, workspace, workspaceId, app),
      {
        legacy: "reject",
        responseMode: "json",
        maxSubscriptions: 0,
      },
    );
    return handler.fetch(request);
  }

  const server = createServer(actor, workspace, workspaceId, app);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
