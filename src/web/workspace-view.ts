import {
  agentsLive,
  isGhost,
  isLive,
  isStale,
  needsMe,
  needsMeCount,
  STREAM_BANDS,
  streamOrder,
  streamRows,
  type StreamRow,
} from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import type { WorkspaceData } from "./workspace-state";

export function selectWorkspace(
  data: WorkspaceData,
  now: number,
  attentionOnly: boolean,
) {
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
  const filtered = new Map(
    canvas
      .filter((item) => !attentionOnly || needsMe(item, now))
      .map((item) => [item.id, item]),
  );

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

  function filterRows(rows: StreamRow<CanvasItem>[]): StreamRow<CanvasItem>[] {
    return rows.flatMap(({ item, children }) => {
      const descendants = filterRows(children);
      return filtered.has(item.id)
        ? [{ item, children: descendants }]
        : descendants;
    });
  }

  // Resolve inherited schedules before applying the Needs me filter.
  const bands = streamRows(visible, now, timezone);
  for (const band of STREAM_BANDS) bands[band] = filterRows(bands[band]);

  return {
    projects,
    filtered,
    tree,
    bands,
    timezone,
    liveCount: agentsLive([...data.items.values()], now).length,
    attentionCount: needsMeCount(canvas, now),
  };
}

export function itemStatus(item: CanvasItem, now: number) {
  if (item.status === "done") return "Done";
  if (item.handoff) return "Needs input";
  if (isStale(item, now)) return "Stale";
  if (isLive(item, now)) return "Live";
  return item.status === "blocked" ? "Blocked" : "Queued";
}
