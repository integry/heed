import { z } from "zod";

export const StatusSchema = z.enum([
  "queued",
  "active",
  "blocked",
  "done",
  "cancelled",
]);
export const TimeTypeSchema = z.enum(["flexible", "fixed", "deadline"]);
export const ScopeSchema = z.enum(["report", "steer"]);
export const EventKindSchema = z.enum([
  "created",
  "status",
  "note",
  "handoff",
  "reopened",
  "moved",
  "notified",
]);

export const DEFAULT_WORKSPACE_ID = "default";
export const INBOX_PROJECT_ID = "inbox";
export const MAX_GUIDANCE_LENGTH = 2_000;

export const TimezoneSchema = z.string().refine((value) => {
  // Intl also accepts numeric offsets in newer runtimes.
  if (!/^[a-z]/i.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Expected an IANA timezone name");

export const GuidanceTextSchema = z
  .string()
  .refine(
    (value) =>
      value.length <= MAX_GUIDANCE_LENGTH ||
      (value.length <= MAX_GUIDANCE_LENGTH * 2 &&
        [...value].length <= MAX_GUIDANCE_LENGTH),
    `Guidance must be at most ${MAX_GUIDANCE_LENGTH} characters`,
  );

export const GuidanceSchema = z.object({
  guidance: GuidanceTextSchema,
  guidance_updated_at: z.iso.datetime().nullable(),
});

export const SettingsSchema = GuidanceSchema.extend({
  schema_version: z.int().positive(),
  timezone: TimezoneSchema,
});

export const SettingSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const sqliteFlag = z.union([z.literal(0), z.literal(1)]);
const nullableText = z.string().nullable();

// These schemas describe SQLite rows, including JSON columns stored as text.
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: nullableText,
  sort: z.int(),
  hidden: sqliteFlag,
});

export const ItemSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: nullableText,
  external_key: nullableText,
  title: z.string(),
  tags: z.string(),
  depth: z.int().min(1).max(3),
  priority: z.int().min(1).max(10),
  scheduled_on: z.iso.date().nullable(),
  sort_key: z.number().nullable(),
  layout_pos: z.string(),
  locked_fields: z.string(),
  time_type: TimeTypeSchema,
  time_at: nullableText,
  status: StatusSchema,
  handoff: sqliteFlag,
  handoff_note: nullableText,
  reopen_count: z.int().nonnegative(),
  reopen_reason: nullableText,
  agent_name: nullableText,
  created_by: z.enum(["human", "agent"]),
  ref_url: nullableText,
  note: nullableText,
  hidden: sqliteFlag,
  last_heartbeat_at: nullableText,
  completed_at: nullableText,
  created_at: z.string(),
  updated_at: z.string(),
});

export const DependencySchema = z
  .object({
    item_id: z.string(),
    blocked_by_id: z.string(),
  })
  .refine(
    ({ item_id, blocked_by_id }) => item_id !== blocked_by_id,
    "An item cannot depend on itself",
  );

export const EventSchema = z.object({
  id: z.int(),
  item_id: z.string(),
  at: z.string(),
  actor: z.string(),
  kind: EventKindSchema,
  detail: nullableText,
});

export const TokenSchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: ScopeSchema,
  default_project_id: nullableText,
  secret_hash: z.string(),
  last_used_at: nullableText,
  created_at: z.string(),
});

export const CreateTokenSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  scope: ScopeSchema.default("report"),
  default_project_id: z.string().min(1).nullish(),
});

export type Status = z.infer<typeof StatusSchema>;
export type TimeType = z.infer<typeof TimeTypeSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type EventKind = z.infer<typeof EventKindSchema>;
export type Guidance = z.infer<typeof GuidanceSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Setting = z.infer<typeof SettingSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Dependency = z.infer<typeof DependencySchema>;
export type Event = z.infer<typeof EventSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type TokenMetadata = Omit<Token, "secret_hash">;
