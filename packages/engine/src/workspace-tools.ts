import { z } from "zod";
import {
  ItemIdSchema,
  ItemShapeSchema,
  PROJECT_COLORS,
  ProjectCodeSchema,
  ProjectColorSchema,
  projectIdentity,
  TimezoneSchema,
} from "@heedwork/core";
import type { Actor } from "@heedwork/core";
import type { LimitAction } from "./seams.js";
import type { Workspace } from "./workspace.js";

const MAX_PROJECTS = 200;
const MAX_ITEM_EVENTS = 20;
const MAX_TEXT = 500;

const projectRef = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("Project name or ID");
const projectName = z.string().trim().min(1).max(120);
const color = ProjectColorSchema;

interface WorkspaceTool<T> {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape> & z.ZodType<T>;
  /** What a report-scope caller is refused, as in "Report scope cannot <action>". */
  steer?: string;
  /** Reads are not recorded as agent writes. */
  read?: true;
  limit?: LimitAction;
  run: (
    workspace: Workspace,
    input: T,
    actor: Actor,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

function tool<T>(definition: WorkspaceTool<T>) {
  return definition as WorkspaceTool<unknown>;
}

function clip(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(clip);
  if (value && typeof value === "object") return clipped(value);
  return value;
}

function clipped(row: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, clip(value)]),
  );
}

/**
 * Workspace operations beyond item reporting. MCP and the text line expose the
 * same list, and the Workspace enforces scope for both.
 */
export const workspaceTools = [
  tool({
    name: "list_projects",
    description:
      "List the workspace's projects with their IDs, in display order. Call it before creating a project to avoid duplicates.",
    schema: z.strictObject({}),
    read: true,
    run: (workspace) => {
      const projects = workspace.listProjects();
      return {
        projects: projects.slice(0, MAX_PROJECTS).map((project) => ({
          id: project.id,
          name: project.name.slice(0, 120),
          color: projectIdentity(project)?.color ?? null,
          code: projectIdentity(project)?.code ?? null,
          hidden: Boolean(project.hidden),
        })),
        may_have_more: projects.length > MAX_PROJECTS,
      };
    },
  }),
  tool({
    name: "create_project",
    description:
      "Create a project so items can be placed in it. Returns the existing project when one already has this name. Then pass its name or ID as project to add_item.",
    schema: z.strictObject({
      name: projectName,
      color: color.optional(),
      code: ProjectCodeSchema.optional(),
    }),
    limit: "project.create",
    run: (workspace, { name, color, code }) => {
      const existing = workspace.findProject(name, false);
      return {
        project:
          existing ??
          workspace.createProject({
            name,
            ...(color !== undefined && { color }),
            ...(code !== undefined && { code }),
          }),
        created: !existing,
      };
    },
  }),
  tool({
    name: "update_project",
    description: `Rename, recolour, re-badge, hide or show a project. Pass only the fields to change. Colours: ${PROJECT_COLORS.join(", ")}. code is the badge shown on its items: one to four letters or digits; null restores the default from the name.`,
    schema: z.strictObject({
      project: projectRef,
      name: projectName.optional(),
      color: color.optional(),
      code: ProjectCodeSchema.nullable().optional(),
      hidden: z.boolean().optional(),
    }),
    steer: "change a project",
    run: (workspace, { project, hidden, ...patch }) => ({
      project: workspace.updateProject(workspace.findProject(project).id, {
        ...patch,
        ...(hidden !== undefined && { hidden: hidden ? 1 : 0 }),
      }),
    }),
  }),
  tool({
    name: "set_tag_shape",
    description:
      "Draw items that carry a tag (a type of work such as call, review or research) as a square, diamond or hexagon on the radar. circle removes the shape. Tag the items with add_item or update_item.",
    schema: z.strictObject({
      tag: z.string().trim().min(1).max(40),
      shape: ItemShapeSchema,
    }),
    steer: "change item shapes",
    run: (workspace, { tag, shape }, actor) =>
      workspace.setTagShape(actor, tag, shape),
  }),
  tool({
    name: "move_project",
    description: "Move a project one place up or down in the display order.",
    schema: z.strictObject({
      project: projectRef,
      direction: z.enum(["up", "down"]),
    }),
    steer: "reorder projects",
    run: (workspace, { project, direction }) => {
      const { id } = workspace.findProject(project);
      workspace.moveProject({ project_id: id, direction });
      return { project_id: id };
    },
  }),
  tool({
    name: "delete_project",
    description:
      "Delete an empty project. Move or delete its items first. Inbox cannot be deleted.",
    schema: z.strictObject({ project: projectRef }),
    steer: "delete a project",
    run: (workspace, { project }) => {
      const { id } = workspace.findProject(project);
      workspace.deleteProject(id);
      return { deleted_project_id: id };
    },
  }),
  tool({
    name: "delete_item",
    description:
      "Permanently delete an item and its children. Use only when the user explicitly asks to delete; to stop work on an item, cancel it with report_progress instead.",
    schema: ItemIdSchema,
    steer: "delete an item",
    run: (workspace, input, actor) => {
      const { item_id, items } = workspace.deleteItem(actor, input);
      return { deleted_item_id: item_id, deleted_count: items.length };
    },
  }),
  tool({
    name: "clear_handoff",
    description:
      "Withdraw the open question on an item without answering it, when it no longer needs the user.",
    schema: ItemIdSchema,
    steer: "clear a handoff",
    run: (workspace, input, actor) => ({
      item_id: workspace.clearHandoff(actor, input).item_id,
    }),
  }),
  tool({
    name: "set_timezone",
    description:
      "Set the workspace timezone as an IANA name such as Europe/Riga. Dates and 'today' follow it.",
    schema: z.strictObject({ timezone: TimezoneSchema }),
    steer: "change the timezone",
    run: (workspace, { timezone }) => {
      workspace.setTimezone(timezone);
      return { timezone };
    },
  }),
  tool({
    name: "get_item",
    description: `Read one item in full, with its ${MAX_ITEM_EVENTS} most recent events (status changes, notes, handoffs, answers). Long text is shortened.`,
    schema: ItemIdSchema,
    read: true,
    run: (workspace, input) => {
      const events = workspace.getItemEvents(input);
      return {
        item: clipped(workspace.getItem(input)),
        events: events.slice(0, MAX_ITEM_EVENTS).map(clipped),
        events_may_have_more: events.length > MAX_ITEM_EVENTS,
      };
    },
  }),
];

export const workspaceToolDefinitions = workspaceTools.map(
  ({ name, description, schema }) => {
    const parameters = z.toJSONSchema(schema, { io: "input" });
    delete parameters.$schema;
    return { name, description, parameters };
  },
);
