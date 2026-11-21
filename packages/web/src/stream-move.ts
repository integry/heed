import { band, firstDayOfBand, type Band } from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import type { MutationInput } from "./workspace-state";

export type StreamMove = Extract<
  MutationInput,
  { type: "UPDATE_ITEM" | "REORDER_ITEMS" }
>;

export function hasFixedOrder(item: CanvasItem) {
  return item.time_type === "fixed" && item.time_at !== null;
}

export function scheduleMove(
  item: CanvasItem,
  target: Band,
  items: ReadonlyMap<string, CanvasItem>,
  now: number,
  timezone: string,
): Extract<StreamMove, { type: "UPDATE_ITEM" }> | null {
  const scheduled_on = firstDayOfBand(target, now, timezone);
  if (target !== "backlog" && scheduled_on === null) return null;
  if (band({ ...item, scheduled_on }, items, now, timezone) !== target)
    return null;
  return { type: "UPDATE_ITEM", input: { item_id: item.id, scheduled_on } };
}

export function reorderMove(
  siblings: readonly CanvasItem[],
  id: string,
  anchor: string | null,
  side: "before" | "after",
): StreamMove | null {
  const movable = siblings.filter((item) => !hasFixedOrder(item));
  const from = movable.findIndex((item) => item.id === id);
  if (from < 0 || anchor === id) return null;
  const [item] = movable.splice(from, 1);
  const anchorIndex = movable.findIndex((row) => row.id === anchor);
  // Fixed-time rows retain their chronological order ahead of manual rows.
  const to =
    anchor === null
      ? side === "before"
        ? 0
        : movable.length
      : anchorIndex < 0
        ? 0
        : anchorIndex + (side === "after" ? 1 : 0);
  if (from === to) return null;

  const updates: { item_id: string; sort_key: number }[] = [];
  const add = (row: CanvasItem, key: number) => {
    if (row.sort_key !== key) updates.push({ item_id: row.id, sort_key: key });
  };
  const next = movable[to]?.sort_key ?? null;
  let previous: number | null = null;
  for (const row of movable.slice(0, to)) {
    // Promote the necessary priority-ordered prefix when dropping among unkeyed items.
    previous = row.sort_key ?? (previous === null ? 0 : previous + 1);
    add(row, previous);
  }
  const key =
    previous === null
      ? (next ?? 1) - 1
      : next === null
        ? previous + 1
        : previous / 2 + next / 2;
  if (
    (previous !== null && key <= previous) ||
    (next !== null && key >= next)
  ) {
    // Equal or adjacent floating-point keys leave no room for a fraction.
    updates.length = 0;
    const ordered = [...movable.slice(0, to), item, ...movable.slice(to)];
    ordered.forEach((row, index) => {
      if (index <= to || row.sort_key !== null) add(row, index);
    });
  } else {
    add(item, key);
  }

  if (updates.length === 1) return { type: "UPDATE_ITEM", input: updates[0] };
  return { type: "REORDER_ITEMS", input: updates };
}
