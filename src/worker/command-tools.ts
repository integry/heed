import { z } from "zod";
import {
  AddItemSchema,
  CanvasQuerySchema,
  FlagHandoffSchema,
  ReopenItemSchema,
  ReportProgressSchema,
  SetDependencySchema,
  SetGuidanceSchema,
  UpdateItemSchema,
} from "../shared/item-operations";
import type { Actor, ItemOperationResult } from "../shared/item-operations";
import type { Workspace } from "./workspace";

export const commandActor = {
  kind: "command",
  scope: "steer",
} as const satisfies Actor;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function tool<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  run: (workspace: Workspace, args: z.output<T>) => unknown,
) {
  const parameters = z.toJSONSchema(schema, {
    io: "input",
  });
  delete parameters.$schema;
  return {
    definition: { name, description, parameters } satisfies ToolDefinition,
    execute(workspace: Workspace, args: unknown) {
      const result = schema.safeParse(args);
      if (!result.success) {
        const { path, message } = result.error.issues[0];
        return { error: [path.join("."), message].filter(Boolean).join(": ") };
      }
      return run(workspace, result.data);
    },
  };
}

function itemResult({ item_id, guidance_updated_at }: ItemOperationResult) {
  return { item_id, guidance_updated_at };
}

const CANVAS_PAGE_SIZE = 40;

export function compactCanvas(
  canvas: ReturnType<Workspace["getCanvas"]>,
  limit = CANVAS_PAGE_SIZE,
  includeLinks = false,
) {
  const { items, ...guidance } = canvas;
  return {
    ...guidance,
    // A full page can conceal another match. Ask for more specific filters.
    items: items
      .slice(0, limit)
      .map(({ id, title, project, status, parent_id, band, ref_url }) => ({
        id,
        title,
        project: project.slice(0, 120),
        status,
        parent_id,
        band,
        ...(includeLinks && ref_url && { ref_url: ref_url.slice(0, 240) }),
      })),
    may_have_more: items.length > limit,
  };
}

export const commandTools = [
  tool(
    "get_canvas",
    "Find items by partial title (query), project name or ID, or parent ID. Set include_done for completed or cancelled items. A full result may hide other matches. Narrow the search or clarify before acting.",
    CanvasQuerySchema,
    (workspace, input) => {
      const limit = Math.min(input.limit, CANVAS_PAGE_SIZE);
      return compactCanvas(
        workspace.getCanvas({ ...input, limit: limit + 1 }),
        limit,
        true,
      );
    },
  ),
  tool(
    "add_item",
    "Add an item or child. Use a project ID. An existing external_key updates its item.",
    AddItemSchema,
    (workspace, input) => itemResult(workspace.addItem(commandActor, input)),
  ),
  tool(
    "report_progress",
    "Change status, note, assignment or reference link for an item. Status may be active, blocked, done or cancelled.",
    ReportProgressSchema,
    (workspace, input) =>
      itemResult(workspace.reportProgress(commandActor, input)),
  ),
  tool(
    "update_item",
    "Edit only the specified item fields. Use project IDs and YYYY-MM-DD for scheduled_on; null clears the date. Pass hidden to hide or show an item.",
    UpdateItemSchema,
    (workspace, input) => itemResult(workspace.updateItem(commandActor, input)),
  ),
  tool(
    "set_dependency",
    "Add or remove a dependency. blocked_by_id is the prerequisite item.",
    SetDependencySchema,
    (workspace, input) => {
      const result = workspace.setDependency(commandActor, input);
      return { ...itemResult(result), dependency: result.dependency };
    },
  ),
  tool(
    "flag_handoff",
    "Flag an item for a human decision and record what is needed. Only send a notification if requested or warranted by guidance.",
    FlagHandoffSchema,
    async (workspace, input) =>
      itemResult(await workspace.flagHandoff(commandActor, input)),
  ),
  tool(
    "reopen_item",
    "Reopen a completed or cancelled item. Record the reason.",
    ReopenItemSchema,
    (workspace, input) => itemResult(workspace.reopenItem(commandActor, input)),
  ),
  tool(
    "set_guidance",
    "Replace standing guidance when explicitly asked. Keep any guidance the user wants to retain.",
    SetGuidanceSchema,
    (workspace, { text }) => workspace.setGuidance(commandActor, text),
  ),
  tool(
    "toggle_project",
    "Hide or show a project by its ID. Pass hidden true to hide, false to show.",
    z.strictObject({ project_id: z.string().min(1), hidden: z.boolean() }),
    (workspace, { project_id, hidden }) => ({
      project: workspace.updateProject(project_id, { hidden: hidden ? 1 : 0 }),
      guidance_updated_at: workspace.getGuidance().guidance_updated_at,
    }),
  ),
];
