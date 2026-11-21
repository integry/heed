import { z } from "zod";
import {
  AddItemSchema,
  FlagHandoffSchema,
  ItemIdSchema,
  ReopenItemSchema,
  ReportProgressSchema,
  SetDependencySchema,
  SetStatusBodySchema,
  UpdateItemSchema,
} from "./item-operations.js";
import type { ItemOperationResult } from "./item-operations.js";
import { JudgeFeedbackDetailSchema } from "./judge.js";
import {
  GuidanceBodySchema,
  ResetWorkspaceBodySchema,
  TimezoneBodySchema,
} from "./human-api.js";
import {
  CreateProjectSchema,
  CreateTokenSchema,
  UpdateProjectSchema,
} from "./workspace.js";
import type {
  Dependency,
  Event,
  Item,
  Project,
  Settings,
  TokenMetadata,
} from "./workspace.js";

export const SocketRequestIdSchema = z.string().min(1).max(128);
export const WORKSPACE_RESET_CLOSE_CODE = 4000;
const resourceId = z.string().min(1);

export const MoveProjectSchema = z.strictObject({
  project_id: resourceId,
  direction: z.enum(["up", "down"]),
});

function mutation<Type extends string, Input extends z.ZodType>(
  type: Type,
  input: Input,
) {
  return z.strictObject({
    type: z.literal(type),
    requestId: SocketRequestIdSchema,
    input,
  });
}

export type CreatedToken = TokenMetadata & { token: string };

// Reordering, rescheduling and positioning use the same fields as HTTP item edits.
export const SocketRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("GET_SNAPSHOT") }),
  mutation("ADD_ITEM", AddItemSchema),
  mutation("UNDO_COMMAND", z.strictObject({ id: z.uuid() })),
  mutation("DELETE_ITEM", ItemIdSchema),
  mutation("REOPEN_ITEM", ReopenItemSchema),
  mutation("FLAG_HANDOFF", FlagHandoffSchema.omit({ notify: true })),
  mutation("CLEAR_HANDOFF", ItemIdSchema),
  mutation(
    "JUDGE_FEEDBACK",
    ItemIdSchema.extend(JudgeFeedbackDetailSchema.shape),
  ),
  mutation("SET_DEPENDENCY", SetDependencySchema),
  mutation(
    "SET_NOTE",
    ItemIdSchema.extend({ note: ReportProgressSchema.shape.note.unwrap() }),
  ),
  mutation("CREATE_PROJECT", CreateProjectSchema),
  mutation("MOVE_PROJECT", MoveProjectSchema),
  mutation("DELETE_PROJECT", z.strictObject({ project_id: resourceId })),
  mutation("SET_TIMEZONE", TimezoneBodySchema),
  mutation("CREATE_TOKEN", CreateTokenSchema),
  mutation("REVOKE_TOKEN", z.strictObject({ token_id: resourceId })),
  mutation("RESET_WORKSPACE", ResetWorkspaceBodySchema),
  mutation("REVOKE_CONNECTED_APP", z.strictObject({ grant_id: resourceId })),
  z.strictObject({
    type: z.literal("UPDATE_ITEM"),
    requestId: SocketRequestIdSchema,
    input: UpdateItemSchema,
  }),
  z.strictObject({
    type: z.literal("SET_STATUS"),
    requestId: SocketRequestIdSchema,
    input: SetStatusBodySchema.extend(ItemIdSchema.shape),
  }),
  z.strictObject({
    type: z.literal("REORDER_ITEMS"),
    requestId: SocketRequestIdSchema,
    input: z.array(ItemIdSchema.extend({ sort_key: z.number() })).min(1),
  }),
  z.strictObject({
    type: z.literal("UPDATE_PROJECT"),
    requestId: SocketRequestIdSchema,
    project_id: z.string().min(1),
    input: UpdateProjectSchema,
  }),
  z.strictObject({
    type: z.literal("INITIALIZE_TIMEZONE"),
    requestId: SocketRequestIdSchema,
    input: TimezoneBodySchema,
  }),
  z.strictObject({
    type: z.literal("SET_GUIDANCE"),
    requestId: SocketRequestIdSchema,
    input: GuidanceBodySchema,
  }),
]);

export type SocketRequest = z.infer<typeof SocketRequestSchema>;
export type ChildCounts = { done: number; total: number };
export type CanvasItem = Item & { progress: ChildCounts };

interface CanvasSnapshot {
  projects: Project[];
  items: CanvasItem[];
  dependencies: Dependency[];
}

export type WorkspaceMessage =
  | ({
      type: "SNAPSHOT";
      settings: Settings;
      timezoneConfigured: boolean;
    } & CanvasSnapshot)
  // Clients retaining an item should keep the newest last_heartbeat_at they have seen.
  | { type: "ITEM_UPSERT"; item: CanvasItem }
  | { type: "ITEM_REMOVE"; item_id: string }
  | { type: "PROJECT_UPSERT"; project: Project }
  | { type: "PROJECT_REMOVE"; project_id: string }
  | { type: "DEPENDENCY_ADD" | "DEPENDENCY_REMOVE"; dependency: Dependency }
  | { type: "SETTINGS_UPDATE"; settings: Settings }
  | { type: "EVENT_APPEND"; event: Event }
  | {
      type: "ACK";
      requestId: string;
      createdToken?: CreatedToken;
      ignored_fields?: ItemOperationResult["ignored_fields"];
    }
  | {
      type: "ERROR";
      requestId: string | null;
      error: { code: string; message: string; limit?: string; reason?: string };
    };

// Sequence numbers are consecutive per connection, including replies and snapshots.
// The runtime-managed text ping/pong keepalive is outside the JSON protocol.
export type SocketMessage = WorkspaceMessage & { seq: number };
