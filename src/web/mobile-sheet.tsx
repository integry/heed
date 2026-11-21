import { useEffect, useRef, useState, type PointerEvent } from "react";

export const sheetStops = ["peek", "half", "full"] as const;
export type SheetStop = (typeof sheetStops)[number];
const stopLabels = { peek: "Peek", half: "Half", full: "Full" };

export function sheetHeights(available: number): Record<SheetStop, number> {
  const half = available / 2;
  return { peek: Math.min(132, half), half, full: available };
}

export function snapSheet(
  height: number,
  velocity: number,
  available: number,
  current: SheetStop,
): SheetStop {
  const heights = sheetHeights(available);
  const projected = height + Math.max(-2, Math.min(2, velocity)) * 160;
  return sheetStops.reduce(
    (nearest, stop) =>
      Math.abs(heights[stop] - projected) <
      Math.abs(heights[nearest] - projected)
        ? stop
        : nearest,
    current,
  );
}

export function useMobileSheet(
  desktop: boolean,
  onChange: (stop: SheetStop) => void,
) {
  const layout = useRef<HTMLElement>(null);
  const pane = useRef<HTMLElement>(null);
  const [stop, setStop] = useState<SheetStop>("peek");
  const [height, setHeight] = useState<number>();
  const drag = useRef<{
    pointer: number;
    y: number;
    height: number;
    samples: { y: number; time: number }[];
    moved: boolean;
  } | null>(null);
  const skipClick = useRef(false);
  const lensStop = useRef<SheetStop>("peek");

  useEffect(() => {
    if (desktop) {
      drag.current = null;
      setHeight(undefined);
    }
  }, [desktop]);

  function changeStop(next: SheetStop) {
    if (next !== "full") lensStop.current = next;
    setStop(next);
    onChange(next);
  }

  function finish(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    drag.current = null;
    setHeight(undefined);
    if (!active.moved) return;
    skipClick.current = true;
    if (event.type !== "pointerup") return;
    const sample = active.samples.find(
      ({ time }) => event.timeStamp - time <= 100,
    );
    const elapsed = sample ? event.timeStamp - sample.time : 0;
    const velocity =
      sample && elapsed > 0 ? (sample.y - event.clientY) / elapsed : 0;
    changeStop(
      snapSheet(
        active.height + active.y - event.clientY,
        velocity,
        layout.current?.clientHeight ?? 0,
        stop,
      ),
    );
  }

  const handle = (
    <div className="sheet-grip">
      <button
        type="button"
        className="sheet-handle"
        aria-controls="mobile-stream"
        aria-label={`Horizon Stream size: ${stopLabels[stop]}. Change sheet size`}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary || !pane.current) return;
          skipClick.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointer: event.pointerId,
            y: event.clientY,
            height: pane.current.getBoundingClientRect().height,
            samples: [{ y: event.clientY, time: event.timeStamp }],
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || active.pointer !== event.pointerId || !layout.current)
            return;
          const delta = active.y - event.clientY;
          if (!active.moved && Math.abs(delta) < 5) return;
          active.moved = true;
          active.samples = active.samples.filter(
            ({ time }) => event.timeStamp - time <= 100,
          );
          active.samples.push({ y: event.clientY, time: event.timeStamp });
          const { peek, full } = sheetHeights(layout.current.clientHeight);
          setHeight(Math.min(full, Math.max(peek, active.height + delta)));
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onClick={(event) => {
          if (skipClick.current && event.detail !== 0) return;
          changeStop(sheetStops[(sheetStops.indexOf(stop) + 1) % 3]);
        }}
        onKeyDown={(event) => {
          const index = sheetStops.indexOf(stop);
          const target = {
            ArrowUp: Math.min(index + 1, 2),
            ArrowDown: Math.max(index - 1, 0),
            Home: 0,
            End: 2,
          }[event.key];
          if (target === undefined) return;
          event.preventDefault();
          changeStop(sheetStops[target]);
        }}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );

  return {
    layout,
    pane,
    stop,
    height,
    handle,
    changeStop,
    toggleList: () => changeStop(stop === "full" ? lensStop.current : "full"),
  };
}
