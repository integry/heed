import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { Band } from "../shared/derived-state";

export type DropSlot = {
  band: Band;
  anchor: string | null;
  side: "before" | "after";
};

export function streamDropSlot(
  x: number,
  y: number,
  pane: HTMLElement,
): DropSlot | null {
  const element = document.elementFromPoint(x, y);
  const section = element?.closest<HTMLElement>("[data-stream-band]");
  if (!section || !pane.contains(section)) return null;
  if (element?.closest("[data-stream-alias]")) return null;
  const row = element?.closest<HTMLElement>("[data-drop-row]");
  const rect = row?.getBoundingClientRect();
  return {
    band: section.dataset.streamBand as Band,
    anchor: row?.dataset.dropRow ?? null,
    side: rect && y < rect.top + rect.height / 2 ? "before" : "after",
  };
}

export function useItemDrag<Slot extends DropSlot & { project?: string }>(
  live: boolean,
  onDrop: (id: string, slot: Slot | null) => void,
  resolveSlot: (x: number, y: number, pane: HTMLElement) => Slot | null,
  onStart: () => void,
  horizontal = false,
) {
  const [drag, setDrag] = useState<{
    id: string;
    slot: Slot | null;
  } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pointer = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    moving: boolean;
    holdUntil: number;
  } | null>(null);
  const frame = useRef(0);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 || pointer.current || !live) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { pointerId, clientX: x, clientY: y } = event;
    pointer.current = {
      id,
      pointerId,
      startX: x,
      startY: y,
      x,
      y,
      moving: false,
      holdUntil: event.pointerType === "touch" ? event.timeStamp + 420 : 0,
    };
    onStart();
  }

  function animateDrag() {
    const current = pointer.current;
    const pane = root.current;
    if (!current?.moving || !pane) return;
    const { x, y, id } = current;
    const { top, bottom, left, right } = pane.getBoundingClientRect();
    if (x >= left && x <= right && y >= top && y <= bottom) {
      const edge = 36;
      if (y < top + edge) pane.scrollTop -= Math.ceil((top + edge - y) / 3);
      if (y > bottom - edge)
        pane.scrollTop += Math.ceil((y - bottom + edge) / 3);
      if (horizontal && x < left + edge)
        pane.scrollLeft -= Math.ceil((left + edge - x) / 3);
      if (horizontal && x > right - edge)
        pane.scrollLeft += Math.ceil((x - right + edge) / 3);
    }
    const slot = resolveSlot(x, y, pane);
    setDrag((previous) =>
      previous?.id === id &&
      previous.slot?.band === slot?.band &&
      previous.slot?.project === slot?.project &&
      previous.slot?.anchor === slot?.anchor &&
      previous.slot?.side === slot?.side
        ? previous
        : { id, slot },
    );
    frame.current = requestAnimationFrame(animateDrag);
  }

  function dragPointer(event: PointerEvent<HTMLButtonElement>) {
    const current = pointer.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (
      !current.moving &&
      Math.hypot(current.x - current.startX, current.y - current.startY) >= 5
    ) {
      if (event.timeStamp < current.holdUntil) {
        pointer.current = null;
        return;
      }
      current.moving = true;
      animateDrag();
    }
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = pointer.current;
    if (!current || current.pointerId !== event.pointerId) return;
    pointer.current = null;
    cancelAnimationFrame(frame.current);
    setDrag(null);
    if (current.moving && root.current && event.type === "pointerup") {
      onDrop(
        current.id,
        resolveSlot(event.clientX, event.clientY, root.current),
      );
    }
  }

  return { drag, root, startDrag, dragPointer, endDrag };
}
