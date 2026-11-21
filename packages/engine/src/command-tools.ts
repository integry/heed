import { z } from "zod";
import {
  AddItemSchema,
  AnswerHandoffSchema,
  CanvasQuerySchema,
  FlagHandoffSchema,
  ReopenItemSchema,
  ReportProgressSchema,
  SetDependencySchema,
  SetGuidanceSchema,
  UpdateItemSchema,
} from "@heedwork/core";
import type { Actor, ItemOperationResult, WorkspaceUser } from "@heedwork/core";
import type { Workspace } from "./workspace.js";

const commandActor = {
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
  run: (
    workspace: Workspace,
    args: z.output<T>,
    actor: typeof commandActor & { user?: WorkspaceUser },
    allowItemCreation: boolean,
  ) => unknown,
) {
  const parameters = z.toJSONSchema(schema, {
    io: "input",
  });
  delete parameters.$schema;
  return {
    definition: { name, description, parameters } satisfies ToolDefinition,
    execute(
      workspace: Workspace,
      args: unknown,
      user: WorkspaceUser | undefined,
      allowItemCreation: boolean,
    ) {
      const result = schema.safeParse(args);
      if (!result.success) {
        const { path, message } = result.error.issues[0];
        return { error: [path.join("."), message].filter(Boolean).join(": ") };
      }
      return run(
        workspace,
        result.data,
        { ...commandActor, user },
        allowItemCreation,
      );
    },
  };
}

function itemResult({
  item_id,
  guidance_updated_at,
  ignored_fields,
  handoff_answer,
  handoff_note,
}: ItemOperationResult) {
  return {
    item_id,
    guidance_updated_at,
    ...(ignored_fields.length > 0 && { ignored_fields }),
    ...(handoff_answer !== undefined && { handoff_answer, handoff_note }),
  };
}

const CANVAS_PAGE_SIZE = 40;

export function compactCanvas(
  canvas: ReturnType<Workspace["getCanvas"]>,
  limit = CANVAS_PAGE_SIZE,
  includeDetails = false,
) {
  const { items, ...guidance } = canvas;
  return {
    ...guidance,
    // A full page can conceal another match. Ask for more specific filters.
    items: items
      .slice(0, limit)
      .map(
        ({
          id,
          title,
          project,
          status,
          parent_id,
          band,
          ref_url,
          acceptance,
          handoff_answer,
          handoff_note,
        }) => ({
          id,
          title,
          project: project.slice(0, 120),
          status,
          parent_id,
          band,
          ...(includeDetails && ref_url && { ref_url }),
          ...(includeDetails && acceptance && { acceptance }),
          ...(includeDetails &&
            handoff_answer !== undefined && {
              handoff_answer,
              handoff_note,
            }),
        }),
      ),
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
    "Add an item or child. Use a project ID. An existing external_key updates its item. Use acceptance for up to eight short, checkable completion criteria.",
    AddItemSchema,
    (workspace, input, actor, allowItemCreation) => {
      const result = allowItemCreation
        ? workspace.addItem(actor, input)
        : workspace.updateExistingItem(actor, input);
      return result && itemResult(result);
    },
  ),
  tool(
    "report_progress",
    "Change status, note, assignment or reference link for an item. Status may be active, blocked, done or cancelled. When changing status to done, include evidence such as actual test or CI output if available.",
    ReportProgressSchema,
    (workspace, input, actor) =>
      itemResult(workspace.reportProgress(actor, input)),
  ),
  tool(
    "update_item",
    "Edit only the specified item fields. Use project IDs and YYYY-MM-DD for scheduled_on; null clears the date. Pass hidden to hide or show an item.",
    UpdateItemSchema,
    (workspace, input, actor) => itemResult(workspace.updateItem(actor, input)),
  ),
  tool(
    "set_dependency",
    "Add or remove a dependency. blocked_by_id is the prerequisite item.",
    SetDependencySchema,
    (workspace, input, actor) => {
      const result = workspace.setDependency(actor, input);
      return { ...itemResult(result), dependency: result.dependency };
    },
  ),
  tool(
    "flag_handoff",
    "Flag an item for a human decision and record what is needed. Pass up to four short suggested replies as options. Only send a notification if requested or warranted by guidance.",
    FlagHandoffSchema,
    async (workspace, input, actor) =>
      itemResult(await workspace.flagHandoff(actor, input)),
  ),
  tool(
    "answer_handoff",
    "Send the user's reply to an open handoff on the specified item. Use the user's own answer and ask for clarification if the item or reply is unclear.",
    AnswerHandoffSchema,
    (workspace, input, actor) =>
      itemResult(workspace.answerHandoff(actor, input)),
  ),
  tool(
    "reopen_item",
    "Reopen a completed or cancelled item. Record the reason.",
    ReopenItemSchema,
    (workspace, input, actor) => itemResult(workspace.reopenItem(actor, input)),
  ),
  tool(
    "set_guidance",
    "Replace standing guidance when explicitly asked. Keep any guidance the user wants to retain.",
    SetGuidanceSchema,
    (workspace, { text }, actor) => workspace.setGuidance(actor, text),
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
