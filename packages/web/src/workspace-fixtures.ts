import type { CanvasItem, SocketMessage } from "@heedwork/core";
import type { Project } from "@heedwork/core";

export const now = Date.parse("2024-04-03T12:00:00Z");
export const settings = {
  timezone: "UTC",
  schema_version: 3,
  guidance: "",
  guidance_updated_at: null,
};
export const project: Project = {
  id: "inbox",
  name: "Inbox",
  color: null,
  sort: 0,
  hidden: 0,
};
export const goal: CanvasItem = {
  id: "goal",
  progress: { done: 0, total: 2 },
  project_id: "inbox",
  parent_id: null,
  external_key: null,
  title: "Payment reliability",
  tags: "[]",
  acceptance: "[]",
  depth: 1,
  priority: 5,
  scheduled_on: "2024-04-03",
  sort_key: null,
  layout_pos: "{}",
  locked_fields: "[]",
  time_type: "flexible",
  time_at: null,
  status: "queued",
  handoff: 0,
  handoff_note: null,
  reopen_count: 0,
  reopen_reason: null,
  agent_name: null,
  created_by: "human",
  ref_url: null,
  note: null,
  hidden: 0,
  last_heartbeat_at: null,
  completed_at: null,
  completed_band: null,
  created_at: "2024-04-03T00:00:00Z",
  updated_at: "2024-04-03T00:00:00Z",
};
export const child: CanvasItem = {
  ...goal,
  id: "child",
  parent_id: goal.id,
  depth: 2,
  title: "Review retry policy",
  scheduled_on: null,
  handoff: 1,
};
export const tomorrow: CanvasItem = {
  ...child,
  id: "tomorrow",
  title: "Run failover drill",
  scheduled_on: "2024-04-04",
  handoff: 0,
};

export const snapshot = {
  type: "SNAPSHOT",
  seq: 1,
  settings,
  timezoneConfigured: true,
  projects: [project],
  items: [goal, child, tomorrow],
  dependencies: [],
} satisfies SocketMessage;
