import {
  agentsLive,
  daySentence,
  isBlocked,
  isGhost,
  isLive,
  isStale,
  needsMe,
  type Band,
  type Ring,
  STREAM_BANDS,
  streamOrder,
  streamRows,
  type StreamRow,
} from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import type { Dependency } from "@heedwork/core";
import type { WorkspaceData } from "./workspace-state";

export const ringLabels: Record<Ring, string> = {
  handoff: "Needs input",
  stale: "Stale",
  reopened: "Reopened",
  blocked: "Blocked",
  live: "Live",
};

export function itemRing(
  item: CanvasItem,
  now: number,
  items: WorkspaceData["items"],
  dependencies: readonly Dependency[],
): Ring | null {
  if (item.status === "done") return null;
  if (item.handoff) return "handoff";
  if (isStale(item, now)) return "stale";
  if (item.reopen_count) return "reopened";
  if (isBlocked(item, items, dependencies)) return "blocked";
  if (isLive(item, now)) return "live";
  return null;
}

export type AttentionGroup = "needs" | "working" | "today" | "done" | "week";
export type AttentionGroups = Record<AttentionGroup, StreamRow<CanvasItem>[]>;

export function selectWorkspace(data: WorkspaceData, now: number) {
  const timezone = data.settings?.timezone ?? "UTC";
  const projects = [...data.projects.values()].sort(
    (a, b) => a.sort - b.sort || a.name.localeCompare(b.name),
  );
  const visible = [...data.items.values()].filter((item) => {
    if (data.projects.get(item.project_id)?.hidden !== 0) return false;
    let root = item;
    while (root.parent_id) {
      const parent = data.items.get(root.parent_id);
      if (!parent) break;
      root = parent;
    }
    return root.hidden === 0;
  });
  const canvas = visible.filter(
    (item) =>
      item.status !== "cancelled" &&
      (item.status !== "done" || isGhost(item, now)),
  );
  const filtered = new Map(canvas.map((item) => [item.id, item]));
  const bands = streamRows(visible, now, timezone);

  const treeById = new Map<string, StreamRow<CanvasItem>>();
  for (const item of streamOrder([...filtered.values()])) {
    treeById.set(item.id, { item, children: [] });
  }
  const tree: StreamRow<CanvasItem>[] = [];
  for (const row of treeById.values()) {
    let parent = row.item.parent_id;
    while (parent && !treeById.has(parent))
      parent = data.items.get(parent)?.parent_id ?? null;
    if (parent) treeById.get(parent)!.children.push(row);
    else tree.push(row);
  }

  const groups: AttentionGroups = {
    needs: [],
    working: [],
    today: [],
    done: [],
    week: [],
  };
  function groupFor(
    band: Band,
    needs: boolean,
    working: boolean,
  ): AttentionGroup | undefined {
    if (needs) return "needs";
    if (working) return "working";
    if (band === "today") return "today";
    if (band === "done-today") return "done";
    if (band === "tomorrow" || band === "this-week") return "week";
  }

  let remaining = 0;
  let attention = 0;
  function addRows(
    rows: StreamRow<CanvasItem>[],
    band: Band,
    parent?: { group: AttentionGroup; row: StreamRow<CanvasItem> },
  ) {
    for (const { item, children } of rows) {
      const needs = band !== "done-today" && needsMe(item, now);
      const working = !needs && isLive(item, now);
      if (needs) attention++;
      if (band === "today" && !working) remaining++;
      const group = groupFor(band, needs, working);
      if (group) {
        const row: StreamRow<CanvasItem> = { item, children: [] };
        (group === parent?.group ? parent.row.children : groups[group]).push(
          row,
        );
        addRows(children, band, { group, row });
      } else {
        addRows(children, band);
      }
    }
  }
  for (const band of STREAM_BANDS) addRows(bands[band], band);
  const liveCount = agentsLive([...data.items.values()], now).length;
  const sentence = daySentence({
    attention,
    agents: liveCount,
    remaining,
    scheduled: Boolean(
      bands.tomorrow.length || bands["this-week"].length || bands.later.length,
    ),
  });

  return {
    projects,
    filtered,
    tree,
    groups,
    sentence,
    timezone,
    liveCount,
    visibleIds: new Set(visible.map(({ id }) => id)),
  };
}

export function itemStatus(
  item: CanvasItem,
  now: number,
  items: WorkspaceData["items"],
  dependencies: readonly Dependency[],
) {
  if (item.status === "done") return "Done";
  if (item.handoff) return "Needs input";
  if (isStale(item, now)) return "Stale";
  if (isBlocked(item, items, dependencies)) return "Blocked";
  if (isLive(item, now)) return "Live";
  return "Queued";
}
