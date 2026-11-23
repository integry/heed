import type { CanvasItem } from "@heedwork/core";

/** Items nest at most three levels deep; the engine enforces the same limit. */
export const MAX_DEPTH = 3;

type Point = { x: number; y: number };
type Circle = { item: CanvasItem; point: Point; radius: number };
type Items = ReadonlyMap<string, CanvasItem>;

function childrenOf(items: Items) {
  const children = new Map<string, CanvasItem[]>();
  for (const item of items.values()) {
    if (item.parent_id === null) continue;
    const siblings = children.get(item.parent_id) ?? [];
    siblings.push(item);
    children.set(item.parent_id, siblings);
  }
  return children;
}

/** The levels below an item: 0 for a leaf, 1 when it has children, and so on. */
export function subtreeHeight(id: string, items: Items): number {
  const children = childrenOf(items);
  const height = (parent: string): number =>
    Math.max(
      0,
      ...(children.get(parent) ?? []).map((child) => 1 + height(child.id)),
    );
  return height(id);
}

function isWithin(id: string, ancestorId: string, items: Items) {
  for (let current = items.get(id); current;) {
    if (current.id === ancestorId) return true;
    current =
      current.parent_id === null ? undefined : items.get(current.parent_id);
  }
  return false;
}

/** Only a drop this far into a bubble nests, so a glancing overlap still moves in time. */
export const NEST_REACH = 0.6;

/** The smallest other bubble whose middle is under the point. */
export function nestTarget<T extends Circle>(
  point: Point,
  circles: readonly T[],
  draggedId: string,
): T | undefined {
  let best: T | undefined;
  for (const circle of circles) {
    if (circle.item.id === draggedId) continue;
    const dx = point.x - circle.point.x;
    const dy = point.y - circle.point.y;
    const reach = circle.radius * NEST_REACH;
    if (dx * dx + dy * dy > reach * reach) continue;
    if (!best || circle.radius < best.radius) best = circle;
  }
  return best;
}

/** Why the item cannot move under the parent (null: top level), or null if it can. */
export function nestProblem(
  item: CanvasItem,
  parentId: string | null,
  items: Items,
): string | null {
  if (parentId !== null && isWithin(parentId, item.id, items))
    return "an item can’t go inside itself";
  const parent = parentId === null ? undefined : items.get(parentId);
  const depth = (parent?.depth ?? 0) + 1;
  if (depth + subtreeHeight(item.id, items) > MAX_DEPTH)
    return `items nest at most ${MAX_DEPTH} levels deep`;
  return null;
}
