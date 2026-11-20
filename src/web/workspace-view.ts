import {
  agentsLive,
  isBlocked,
  isGhost,
  isLive,
  isStale,
  needsMe,
  STREAM_BANDS,
  streamOrder,
  streamRows,
  type StreamRow,
} from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import type { Dependency } from "../shared/workspace";
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
  const attentionIds = new Set(
    canvas.filter((item) => needsMe(item, now)).map((item) => item.id),
  );
  const allBands = streamRows(visible, now, timezone);
  function collectAttention(rows: StreamRow<CanvasItem>[]) {
    for (const { item, children } of rows) {
      if (needsMe(item, now)) attentionIds.add(item.id);
      collectAttention(children);
    }
  }
  for (const band of STREAM_BANDS) collectAttention(allBands[band]);

  const attentionContext = new Set(attentionIds);
  for (const id of attentionIds) {
    let parent = data.items.get(id)?.parent_id;
    while (parent && !attentionContext.has(parent)) {
      attentionContext.add(parent);
      parent = data.items.get(parent)?.parent_id;
    }
  }
  const filtered = new Map(
    canvas
      .filter((item) => !attentionOnly || attentionContext.has(item.id))
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
    return rows
      .filter(({ item }) => attentionContext.has(item.id))
      .map(({ item, children }) => ({ item, children: filterRows(children) }));
  }

  const bands = { ...allBands };
  if (attentionOnly) {
    for (const band of STREAM_BANDS) bands[band] = filterRows(allBands[band]);
  }

  return {
    projects,
    filtered,
    tree,
    bands,
    allBands,
    timezone,
    liveCount: agentsLive([...data.items.values()], now).length,
    attentionCount: attentionIds.size,
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
