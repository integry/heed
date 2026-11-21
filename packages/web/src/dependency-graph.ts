import type { CanvasItem } from "@heedwork/core";
import type { Dependency } from "@heedwork/core";

export function isDescendant(
  id: string,
  ancestor: string,
  items: ReadonlyMap<string, CanvasItem>,
) {
  let parent = items.get(id)?.parent_id;
  while (parent) {
    if (parent === ancestor) return true;
    parent = items.get(parent)?.parent_id;
  }
  return false;
}

export function scopeDependencies(
  goalId: string,
  items: ReadonlyMap<string, CanvasItem>,
  visible: ReadonlyMap<string, CanvasItem>,
  dependencies: readonly Dependency[],
) {
  const descendants = new Set(
    [...visible.keys()].filter((id) => isDescendant(id, goalId, items)),
  );
  const nodes = new Map([...descendants].map((id) => [id, visible.get(id)!]));
  const edges = dependencies.filter(({ item_id, blocked_by_id }) => {
    if (!descendants.has(item_id) && !descendants.has(blocked_by_id))
      return false;
    const blocked = visible.get(item_id);
    const blocker = visible.get(blocked_by_id);
    if (!blocked || !blocker) return false;
    nodes.set(item_id, blocked);
    nodes.set(blocked_by_id, blocker);
    return true;
  });
  return { nodes, edges, descendants };
}

export const CARD_WIDTH = 186;
export const CARD_HEIGHT = 104;
const COLUMN_GAP = 63;
const ROW_GAP = 18;
const PADDING = 22;

type Point = { x: number; y: number };
type Slot = Point & {
  layer: number;
  order: number;
  height: number;
  before: Slot[];
  after: Slot[];
};

function slot(height: number): Slot {
  return { height, layer: 0, order: 0, x: 0, y: 0, before: [], after: [] };
}

function connect(from: Slot, to: Slot) {
  from.after.push(to);
  to.before.push(from);
}

export function layoutDependencies(
  nodes: ReadonlyMap<string, CanvasItem>,
  edges: readonly Dependency[],
) {
  const ranked = [...nodes.values()].sort(
    (a, b) =>
      Number(b.status === "done") - Number(a.status === "done") ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
  const positions = new Map(ranked.map(({ id }) => [id, slot(CARD_HEIGHT)]));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const { item_id, blocked_by_id } of edges) {
    incoming.set(item_id, (incoming.get(item_id) ?? 0) + 1);
    const targets = outgoing.get(blocked_by_id) ?? [];
    targets.push(item_id);
    outgoing.set(blocked_by_id, targets);
  }

  // Each target gets one more than the greatest layer of its prerequisites.
  const ready = ranked
    .filter(({ id }) => !incoming.has(id))
    .map(({ id }) => id);
  for (let index = 0; index < ready.length; index++) {
    const source = ready[index];
    for (const target of outgoing.get(source) ?? []) {
      const next = positions.get(target)!;
      next.layer = Math.max(next.layer, positions.get(source)!.layer + 1);
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (!remaining) ready.push(target);
    }
  }

  const columns: Slot[][] = [];
  function place(node: Slot, layer: number) {
    const column = (columns[layer] ??= []);
    node.layer = layer;
    node.order = column.length;
    column.push(node);
  }
  for (const node of positions.values()) place(node, node.layer);

  // Reserve a small slot in each column a long edge passes through.
  const routes = edges.map((edge) => {
    const start = positions.get(edge.blocked_by_id)!;
    const end = positions.get(edge.item_id)!;
    const waypoints = [start];
    let previous = start;
    for (let layer = start.layer + 1; layer < end.layer; layer++) {
      const waypoint = slot(0);
      place(waypoint, layer);
      connect(previous, waypoint);
      waypoints.push(waypoint);
      previous = waypoint;
    }
    connect(previous, end);
    return { edge, waypoints: [...waypoints, end] };
  });

  // Sweep in both directions, aligning each slot with the average of its neighbors.
  function sweep(layers: Slot[][], side: "before" | "after") {
    for (const layer of layers) {
      const scores = new Map(
        layer.map((node) => {
          const neighbors = node[side];
          const score = neighbors.length
            ? neighbors.reduce((sum, neighbor) => sum + neighbor.order, 0) /
              neighbors.length
            : node.order;
          return [node, score];
        }),
      );
      layer.sort((a, b) => scores.get(a)! - scores.get(b)!);
      layer.forEach((node, order) => (node.order = order));
    }
  }
  sweep(columns, "before");
  sweep([...columns].reverse(), "after");

  const heights = columns.map((column) =>
    column.reduce((height, node) => height + node.height + ROW_GAP, -ROW_GAP),
  );
  const innerHeight = Math.max(0, ...heights);
  columns.forEach((column, layer) => {
    let top = PADDING + (innerHeight - heights[layer]) / 2;
    for (const node of column) {
      node.x = PADDING + layer * (CARD_WIDTH + COLUMN_GAP);
      node.y = top + node.height / 2;
      top += node.height + ROW_GAP;
    }
  });
  return {
    positions,
    routes,
    width:
      2 * PADDING +
      Math.max(0, columns.length * (CARD_WIDTH + COLUMN_GAP) - COLUMN_GAP),
    height: 2 * PADDING + innerHeight,
  };
}

export function blockerCounts(
  nodes: ReadonlyMap<string, CanvasItem>,
  edges: readonly Dependency[],
) {
  const open = new Set(
    [...nodes.values()]
      .filter(({ status }) => status !== "done" && status !== "cancelled")
      .map(({ id }) => id),
  );
  const outgoing = new Map<string, string[]>();
  for (const { item_id, blocked_by_id } of edges) {
    if (!open.has(item_id) || !open.has(blocked_by_id)) continue;
    const targets = outgoing.get(blocked_by_id) ?? [];
    targets.push(item_id);
    outgoing.set(blocked_by_id, targets);
  }
  const counts = new Map<string, number>();
  for (const [id, targets] of outgoing) {
    // A shared downstream item counts once even if several paths reach it.
    const reachable = new Set(targets);
    for (const target of reachable) {
      for (const next of outgoing.get(target) ?? []) reachable.add(next);
    }
    reachable.delete(id);
    if (reachable.size) counts.set(id, reachable.size);
  }
  return counts;
}

export function dependencyPath(points: readonly Point[]) {
  return points.reduce((path, point, index) => {
    if (!index) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1];
    const middle = (previous.x + point.x) / 2;
    return `${path} C ${middle} ${previous.y} ${middle} ${point.y} ${point.x} ${point.y}`;
  }, "");
}
