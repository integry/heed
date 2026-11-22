import type {
  CanvasItem,
  SocketMessage,
  WorkspaceMutation,
} from "@heedwork/core";
import type { Dependency, Project, Settings } from "@heedwork/core";

export type MutationInput = WorkspaceMutation;

export interface WorkspaceData {
  settings: Settings | null;
  projects: ReadonlyMap<string, Project>;
  items: ReadonlyMap<string, CanvasItem>;
  dependencies: ReadonlyMap<string, Dependency>;
}

export interface WorkspaceState extends WorkspaceData {
  seq: number;
  eventRevisions: ReadonlyMap<string, number>;
  snapshotRevision: number;
  judgeAgreementRevision: number;
  connection: "connecting" | "live" | "syncing" | "reconnecting";
  pending: ReadonlyMap<string, MutationInput>;
  error: string | null;
}

export function initialWorkspaceState(): WorkspaceState {
  return {
    settings: null,
    projects: new Map(),
    items: new Map(),
    dependencies: new Map(),
    seq: 0,
    eventRevisions: new Map(),
    snapshotRevision: 0,
    judgeAgreementRevision: 0,
    connection: "connecting",
    pending: new Map(),
    error: null,
  };
}

function setEntry<T>(map: ReadonlyMap<string, T>, key: string, value: T) {
  return new Map(map).set(key, value);
}

function removeEntry<T>(map: ReadonlyMap<string, T>, key: string) {
  const updated = new Map(map);
  updated.delete(key);
  return updated;
}

function dependencyKey({ item_id, blocked_by_id }: Dependency) {
  return JSON.stringify([item_id, blocked_by_id]);
}

function heartbeatTime(value: string | null) {
  if (!value) return -Infinity;
  return Date.parse(
    value.includes(" ") ? value.replace(" ", "T") + "Z" : value,
  );
}

function retainHeartbeat(item: CanvasItem, previous?: CanvasItem): CanvasItem {
  if (
    previous &&
    heartbeatTime(previous.last_heartbeat_at) >
      heartbeatTime(item.last_heartbeat_at)
  ) {
    return { ...item, last_heartbeat_at: previous.last_heartbeat_at };
  }
  return item;
}

function replaceCanvas(
  state: WorkspaceState,
  message: Extract<SocketMessage, { type: "SNAPSHOT" }>,
) {
  return {
    projects: new Map(message.projects.map((project) => [project.id, project])),
    items: new Map(
      message.items.map((item) => [
        item.id,
        retainHeartbeat(item, state.items.get(item.id)),
      ]),
    ),
    dependencies: new Map(
      message.dependencies.map((edge) => [dependencyKey(edge), edge]),
    ),
  };
}

export function receiveMessage(
  state: WorkspaceState,
  message: SocketMessage,
): WorkspaceState {
  if (message.seq <= state.seq) return state;

  if (message.type === "SNAPSHOT") {
    return {
      ...state,
      ...replaceCanvas(state, message),
      seq: message.seq,
      eventRevisions: new Map(),
      snapshotRevision: state.snapshotRevision + 1,
      judgeAgreementRevision: state.judgeAgreementRevision + 1,
      connection: "live",
      pending: new Map(),
      settings: message.settings,
    };
  }

  if (state.connection === "syncing") {
    return message.type === "ERROR"
      ? { ...state, error: message.error.message }
      : state;
  }
  if (state.connection !== "live" || message.seq !== state.seq + 1) {
    // A replacement snapshot includes all previously sent mutations. In the meantime
    // retain the last complete view, and surface any mutation errors we do receive.
    return {
      ...state,
      connection: "syncing",
      pending: new Map(),
      error: message.type === "ERROR" ? message.error.message : state.error,
    };
  }

  const next = {
    ...state,
    seq: message.seq,
  };
  switch (message.type) {
    case "ITEM_UPSERT":
      return {
        ...next,
        items: setEntry(
          state.items,
          message.item.id,
          retainHeartbeat(message.item, state.items.get(message.item.id)),
        ),
      };
    case "ITEM_REMOVE":
      return {
        ...next,
        items: removeEntry(state.items, message.item_id),
        judgeAgreementRevision: state.judgeAgreementRevision + 1,
      };
    case "PROJECT_UPSERT":
      return {
        ...next,
        projects: setEntry(state.projects, message.project.id, message.project),
      };
    case "PROJECT_REMOVE":
      return {
        ...next,
        projects: removeEntry(state.projects, message.project_id),
      };
    case "DEPENDENCY_ADD":
      return {
        ...next,
        dependencies: setEntry(
          state.dependencies,
          dependencyKey(message.dependency),
          message.dependency,
        ),
      };
    case "DEPENDENCY_REMOVE":
      return {
        ...next,
        dependencies: removeEntry(
          state.dependencies,
          dependencyKey(message.dependency),
        ),
      };
    case "SETTINGS_UPDATE":
      return { ...next, settings: message.settings };
    case "EVENT_APPEND":
      return {
        ...next,
        eventRevisions: setEntry(
          state.eventRevisions,
          message.event.item_id,
          message.event.id,
        ),
        judgeAgreementRevision: state.judgeAgreementRevision + 1,
      };
    case "ACK":
      return {
        ...next,
        pending: removeEntry(state.pending, message.requestId),
      };
    case "ERROR":
      return {
        ...next,
        pending: message.requestId
          ? removeEntry(state.pending, message.requestId)
          : state.pending,
        error: message.error.message,
      };
  }
}

export function queueMutation(
  state: WorkspaceState,
  id: string,
  mutation: MutationInput,
): WorkspaceState {
  return {
    ...state,
    pending: setEntry(state.pending, id, mutation),
    error: null,
  };
}

export function workspaceView(state: WorkspaceState): WorkspaceData {
  let { settings } = state;
  const projects = new Map(state.projects);
  const items = new Map(state.items);
  // Replay pending changes over the latest server state. A rejection can then
  // remove just its own changes without undoing broadcasts or newer edits.
  for (const mutation of state.pending.values()) {
    switch (mutation.type) {
      case "UPDATE_PROJECT": {
        const project = projects.get(mutation.project_id);
        if (project)
          projects.set(project.id, { ...project, ...mutation.input });
        break;
      }
      case "UPDATE_ITEM": {
        const {
          item_id,
          project,
          scheduled_on,
          sort_key,
          priority,
          layout_pos,
        } = mutation.input;
        const item = items.get(item_id);
        if (!item) break;
        const nextProject = item.parent_id === null ? project : undefined;
        items.set(item_id, {
          ...item,
          project_id: nextProject ?? item.project_id,
          scheduled_on:
            scheduled_on === undefined ? item.scheduled_on : scheduled_on,
          sort_key: sort_key === undefined ? item.sort_key : sort_key,
          priority: priority ?? item.priority,
          layout_pos: layout_pos ? JSON.stringify(layout_pos) : item.layout_pos,
        });
        if (nextProject) {
          for (const child of items.values()) {
            let parent = child.parent_id;
            while (parent && parent !== item_id)
              parent = items.get(parent)?.parent_id ?? null;
            if (parent === item_id)
              items.set(child.id, { ...child, project_id: nextProject });
          }
        }
        break;
      }
      case "REORDER_ITEMS":
        for (const { item_id, sort_key } of mutation.input) {
          const item = items.get(item_id);
          if (item) items.set(item_id, { ...item, sort_key });
        }
        break;
      case "SET_GUIDANCE":
        if (settings) settings = { ...settings, guidance: mutation.input.text };
        break;
    }
  }
  return { settings, projects, items, dependencies: state.dependencies };
}
