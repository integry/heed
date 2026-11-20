import type { CanvasItem } from "../shared/workspace-socket";
import type { RadarBand } from "../shared/workspace";
import { reorderMove, scheduleMove, type StreamMove } from "./stream-move";
import type { DropSlot } from "./use-item-drag";

export type BoardCell = { project: string; band: RadarBand };
export type BoardSlot = BoardCell & Pick<DropSlot, "anchor" | "side">;

export function boardMove(
  item: CanvasItem,
  source: BoardCell,
  target: BoardSlot,
  peers: readonly CanvasItem[],
  items: ReadonlyMap<string, CanvasItem>,
  now: number,
  timezone: string,
): StreamMove | null {
  if (
    item.parent_id !== null ||
    item.status === "done" ||
    item.status === "cancelled"
  )
    return null;
  const project =
    source.project === target.project ? undefined : target.project;
  if (source.band !== target.band) {
    const schedule = scheduleMove(
      item,
      target.band === "this-week" ? "tomorrow" : target.band,
      items,
      now,
      timezone,
    );
    if (!schedule) return null;
    return {
      type: "UPDATE_ITEM",
      input: {
        ...schedule.input,
        ...(project === undefined ? {} : { project }),
      },
    };
  }
  if (project !== undefined)
    return { type: "UPDATE_ITEM", input: { item_id: item.id, project } };
  return reorderMove(peers, item.id, target.anchor, target.side);
}
