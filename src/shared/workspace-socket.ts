import { z } from "zod";
import {
  ItemIdSchema,
  SetStatusBodySchema,
  UpdateItemSchema,
} from "./item-operations";
import {
  GuidanceBodySchema,
  ReopenBodySchema,
  TimezoneBodySchema,
} from "./human-api";
import { UpdateProjectSchema } from "./workspace";
import type { Dependency, Item, Project, Settings } from "./workspace";

export const SocketRequestIdSchema = z.string().min(1).max(128);

// Reordering, rescheduling and positioning use the same fields as HTTP item edits.
export const SocketRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("GET_SNAPSHOT") }),
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
    type: z.literal("REOPEN_ITEM"),
    requestId: SocketRequestIdSchema,
    input: ReopenBodySchema.extend(ItemIdSchema.shape),
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

export type WorkspaceMessage =
  | {
      type: "SNAPSHOT";
      settings: Settings;
      timezoneConfigured: boolean;
      projects: Project[];
      items: CanvasItem[];
      dependencies: Dependency[];
    }
  // Clients retaining an item should keep the newest last_heartbeat_at they have seen.
  | { type: "ITEM_UPSERT"; item: CanvasItem }
  | { type: "ITEM_REMOVE"; item_id: string }
  | { type: "PROJECT_UPSERT"; project: Project }
  | { type: "PROJECT_REMOVE"; project_id: string }
  | { type: "DEPENDENCY_ADD" | "DEPENDENCY_REMOVE"; dependency: Dependency }
  | { type: "SETTINGS_UPDATE"; settings: Settings }
  | { type: "ACK"; requestId: string }
  | {
      type: "ERROR";
      requestId: string | null;
      error: { code: string; message: string };
    };

// Sequence numbers are consecutive per connection, including replies and snapshots.
// The runtime-managed text ping/pong keepalive is outside the JSON protocol.
export type SocketMessage = WorkspaceMessage & { seq: number };
