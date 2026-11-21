import { z } from "zod";
import {
  GuidanceTextSchema,
  ScopeSchema,
  WorkspaceUserSchema,
  StatusSchema,
  TimeTypeSchema,
} from "./workspace.js";
import type { Dependency, Item } from "./workspace.js";

const id = z.string().min(1);
const agentName = z.string().min(1);
const title = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.length <= 200 || (value.length <= 400 && [...value].length <= 200),
    "Title must be at most 200 characters",
  );
const note = z
  .string()
  .refine(
    (value) =>
      value.length <= 280 || (value.length <= 560 && [...value].length <= 280),
    "Notes must be at most 280 characters",
  );

export const MAX_CANVAS_ITEMS = 200;
export const CanvasQuerySchema = z.strictObject({
  project: z.string().optional(),
  parent_id: id.nullable().optional(),
  query: z.string().optional(),
  include_done: z.boolean().default(false),
  limit: z.int().positive().default(50),
});

export const SetGuidanceSchema = z.strictObject({ text: GuidanceTextSchema });

export const ActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("human"),
    user: WorkspaceUserSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("command"),
    scope: z.literal("steer"),
    user: WorkspaceUserSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("agent"),
    scope: ScopeSchema,
    name: agentName,
    token_id: id.optional(),
    default_project_id: id.nullish(),
  }),
]);

export const LockableFieldSchema = z.enum([
  "priority",
  "scheduled_on",
  "sort_key",
  "layout_pos",
  "acceptance",
]);

const placement = {
  parent_id: id.nullable().optional(),
  project: id.optional(),
};

const itemFields = {
  ...placement,
  title,
  tags: z.array(z.string()),
  acceptance: z
    .array(
      z
        .string()
        .trim()
        .min(1, "Acceptance criteria must not be empty")
        .refine(
          (value) =>
            value.length <= 200 ||
            (value.length <= 400 && [...value].length <= 200),
          "Each acceptance criterion must be at most 200 characters",
        )
        .meta({ maxLength: 200 }),
    )
    .max(8, "Provide at most 8 acceptance criteria"),
  ref_url: z.url().nullable(),
  priority: z.int().min(1).max(10),
  scheduled_on: z.iso.date().nullable(),
  time_type: TimeTypeSchema,
  time_at: z.iso.datetime({ offset: true }).nullable(),
};

const assignment = {
  agent_name: agentName.nullable().optional(),
  note: note.nullable().optional(),
};

export const AddItemSchema = z.strictObject({
  ...z.object(itemFields).partial().shape,
  ...assignment,
  title,
  external_key: id.optional(),
  status: StatusSchema.optional(),
});

export const UpdateItemSchema = z.strictObject({
  ...z.object(itemFields).partial().shape,
  item_id: id,
  hidden: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  sort_key: z.number().nullable().optional(),
  layout_pos: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  unlock: LockableFieldSchema.optional(),
});

const itemSelector = z
  .strictObject({
    item_id: id.optional(),
    external_key: id.optional(),
  })
  .refine(
    ({ item_id, external_key }) =>
      (item_id === undefined) !== (external_key === undefined),
    "Provide exactly one of item_id or external_key",
  );

const progressFields = {
  ...assignment,
  status: StatusSchema.exclude(["queued"]).optional(),
  ref_url: itemFields.ref_url.optional(),
  evidence: z
    .string()
    .refine(
      (value) =>
        value.length <= 4_000 ||
        (value.length <= 8_000 && [...value].length <= 4_000),
      "Evidence must be at most 4,000 characters",
    )
    .meta({ maxLength: 4_000 })
    .optional(),
};

export const ReportProgressSchema = itemSelector.safeExtend(progressFields);
export const SetStatusBodySchema = z.strictObject(progressFields).required({
  status: true,
});

export const ReopenItemSchema = itemSelector.safeExtend({
  reason: note.min(1),
});
export const ItemIdSchema = z.strictObject({ item_id: id });
export const MAX_HANDOFF_ANSWER_LENGTH = 2_000;

function handoffText(maxLength: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.length <= maxLength ||
        (value.length <= maxLength * 2 && [...value].length <= maxLength),
      `Use at most ${maxLength} characters`,
    )
    .meta({ maxLength });
}

export const HandoffOptionsSchema = z.array(handoffText(60)).max(4);
export const FlagHandoffSchema = ItemIdSchema.extend({
  note: note.min(1),
  options: HandoffOptionsSchema.optional(),
  notify: z.boolean().optional(),
});

export const AnswerHandoffSchema = ItemIdSchema.extend({
  text: handoffText(MAX_HANDOFF_ANSWER_LENGTH),
});

export const DependencyBodySchema = ItemIdSchema.extend({
  blocked_by_id: id,
}).refine(
  ({ item_id, blocked_by_id }) => item_id !== blocked_by_id,
  "An item cannot depend on itself",
);
export const SetDependencySchema = DependencyBodySchema.safeExtend({
  action: z.enum(["add", "remove"]),
});

export type Actor = z.infer<typeof ActorSchema>;
export type LockableField = z.infer<typeof LockableFieldSchema>;
export type AddItemInput = z.infer<typeof AddItemSchema>;
export type UpdateItemInput = z.infer<typeof UpdateItemSchema>;
export type ReportProgressInput = z.infer<typeof ReportProgressSchema>;
export type ReopenItemInput = z.infer<typeof ReopenItemSchema>;
export type ItemIdInput = z.infer<typeof ItemIdSchema>;
export type FlagHandoffInput = z.infer<typeof FlagHandoffSchema>;
export type AnswerHandoffInput = z.infer<typeof AnswerHandoffSchema>;
export type SetDependencyInput = z.infer<typeof SetDependencySchema>;

export interface ItemOperationResult {
  item_id: string;
  handoff_answer?: string;
  handoff_note?: Item["handoff_note"];
  /** Changed rows, or the removed rows for deleteItem. */
  items: Item[];
  ignored_fields: (LockableField | "evidence")[];
  guidance_updated_at: string | null;
}

export interface DependencyOperationResult extends ItemOperationResult {
  dependency: (Dependency & { action: SetDependencyInput["action"] }) | null;
}

export interface HandoffOperationResult extends ItemOperationResult {
  notification?: "queued" | "rate_limited" | "unavailable";
}
