import { expect, it } from "vitest";
import {
  child,
  goal,
  now,
  project,
  settings,
  snapshot,
} from "./workspace-fixtures";
import {
  initialWorkspaceState,
  queueMutation,
  receiveMessage,
  workspaceView,
} from "./workspace-state";
import { selectWorkspace } from "./workspace-view";

it("applies snapshots and every workspace delta", () => {
  let state = receiveMessage(initialWorkspaceState(), snapshot);
  expect(state.connection).toBe("live");
  expect(state.projects.get(project.id)).toEqual(project);
  expect(state.items.get(goal.id)).toEqual(goal);

  const updated = {
    ...goal,
    title: "Updated goal",
    last_heartbeat_at: "2024-04-03T12:00:00Z",
  };
  state = receiveMessage(state, { type: "ITEM_UPSERT", seq: 2, item: updated });
  expect(state.items.get(goal.id)).toEqual(updated);
  state = receiveMessage(state, {
    type: "ITEM_UPSERT",
    seq: 3,
    item: { ...goal, last_heartbeat_at: "2024-04-03 11:59:00" },
  });
  expect(state.items.get(goal.id)?.last_heartbeat_at).toBe(
    updated.last_heartbeat_at,
  );
  state = receiveMessage(state, {
    type: "ITEM_REMOVE",
    seq: 4,
    item_id: goal.id,
  });
  expect(state.items.has(goal.id)).toBe(false);

  const hidden = { ...project, hidden: 1 as const };
  state = receiveMessage(state, {
    type: "PROJECT_UPSERT",
    seq: 5,
    project: hidden,
  });
  expect(state.projects.get(project.id)).toEqual(hidden);
  state = receiveMessage(state, {
    type: "PROJECT_REMOVE",
    seq: 6,
    project_id: project.id,
  });
  expect(state.projects.has(project.id)).toBe(false);

  const dependency = { item_id: child.id, blocked_by_id: goal.id };
  state = receiveMessage(state, { type: "DEPENDENCY_ADD", seq: 7, dependency });
  expect([...state.dependencies.values()]).toEqual([dependency]);
  state = receiveMessage(state, {
    type: "DEPENDENCY_REMOVE",
    seq: 8,
    dependency,
  });
  expect(state.dependencies.size).toBe(0);

  const updatedSettings = { ...settings, guidance: "Review billing work." };
  state = receiveMessage(state, {
    type: "SETTINGS_UPDATE",
    seq: 9,
    settings: updatedSettings,
  });
  expect(state.settings).toEqual(updatedSettings);
  expect(state.seq).toBe(9);
});

it("waits for a replacement snapshot on a gap and ignores duplicate messages", () => {
  const base = receiveMessage(initialWorkspaceState(), snapshot);
  const gapped = receiveMessage(base, {
    type: "ITEM_REMOVE",
    seq: 3,
    item_id: goal.id,
  });
  expect(gapped).toMatchObject({ seq: 1, connection: "syncing" });
  expect(gapped.items).toBe(base.items);
  expect(
    receiveMessage(gapped, { type: "ITEM_REMOVE", seq: 4, item_id: child.id }),
  ).toBe(gapped);
  const recovered = receiveMessage(gapped, {
    ...snapshot,
    seq: 5,
    items: [child],
  });
  expect(recovered).toMatchObject({ seq: 5, connection: "live" });
  expect([...recovered.items.values()]).toEqual([child]);
  expect(receiveMessage(recovered, snapshot)).toBe(recovered);
});

it("rolls back rejected mutations without undoing newer pending changes or broadcasts", () => {
  let state = receiveMessage(initialWorkspaceState(), snapshot);
  state = queueMutation(state, "first", {
    type: "UPDATE_ITEM",
    input: { item_id: goal.id, priority: 8 },
  });
  state = queueMutation(state, "second", {
    type: "UPDATE_ITEM",
    input: { item_id: goal.id, scheduled_on: null },
  });
  state = receiveMessage(state, {
    type: "ITEM_UPSERT",
    seq: 2,
    item: { ...goal, title: "New title from server" },
  });
  expect(workspaceView(state).items.get(goal.id)).toMatchObject({
    priority: 8,
    scheduled_on: null,
  });
  state = receiveMessage(state, {
    type: "ERROR",
    seq: 3,
    requestId: "first",
    error: { code: "invalid", message: "Edit rejected" },
  });
  expect(state.error).toBe("Edit rejected");
  expect(workspaceView(state).items.get(goal.id)).toMatchObject({
    priority: goal.priority,
    scheduled_on: null,
    title: "New title from server",
  });
  expect([...state.pending.keys()]).toEqual(["second"]);
  state = receiveMessage(state, {
    type: "ITEM_UPSERT",
    seq: 4,
    item: { ...goal, scheduled_on: null },
  });
  state = receiveMessage(state, { type: "ACK", seq: 5, requestId: "second" });
  expect(state.pending.size).toBe(0);
  expect(workspaceView(state).items.get(goal.id)?.scheduled_on).toBeNull();
});

it("filters hidden projects from both panes and preserves inherited schedules in Needs me", () => {
  let state = receiveMessage(initialWorkspaceState(), snapshot);
  const view = () => selectWorkspace(workspaceView(state), now, true);
  expect(view().tree.map(({ item }) => item.id)).toEqual([child.id]);
  expect(view().bands.today.map(({ item }) => item.id)).toEqual([child.id]);
  state = queueMutation(state, "hide", {
    type: "UPDATE_PROJECT",
    project_id: project.id,
    input: { hidden: 1 },
  });
  expect(view().tree).toEqual([]);
  expect(view().bands.today).toEqual([]);
  expect(view().attentionCount).toBe(0);
  state = receiveMessage(state, {
    type: "ERROR",
    seq: 2,
    requestId: "hide",
    error: { code: "invalid", message: "Edit rejected" },
  });
  expect(view().attentionCount).toBe(1);
});
