import { useCallback, useEffect, useRef, type PointerEvent } from "react";

const holdTime = 420;
const moveThreshold = 5;

export function useCanvasDrag<Data>(clearPreview: () => void) {
  const pointer = useRef<{
    id: number;
    x: number;
    y: number;
    data: Data;
    armed: boolean;
    moved: boolean;
  } | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const suppressClick = useRef(false);

  const cancel = useCallback(() => {
    clearTimeout(hold.current);
    hold.current = undefined;
    if (pointer.current?.moved || pointer.current?.armed)
      suppressClick.current = true;
    pointer.current = null;
    clearPreview();
  }, [clearPreview]);

  useEffect(() => () => clearTimeout(hold.current), []);

  const start = useCallback((event: PointerEvent<Element>, data: Data) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      data,
      armed: false,
      moved: false,
    };
    pointer.current = current;
    // Touch pointers already have implicit capture. Preserve native tap targets.
    if (event.pointerType === "touch") {
      hold.current = setTimeout(() => {
        hold.current = undefined;
        if (pointer.current === current) current.armed = true;
      }, holdTime);
    } else {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }, []);

  function movement(event: PointerEvent<Element>) {
    const current = pointer.current;
    if (current?.id !== event.pointerId) return;
    if (current.moved) return current.data;
    if (
      Math.hypot(event.clientX - current.x, event.clientY - current.y) <
      moveThreshold
    )
      return;
    if (hold.current !== undefined) {
      suppressClick.current = true;
      cancel();
      return;
    }
    current.moved = true;
    return current.data;
  }

  function finish(event: PointerEvent<Element>) {
    if (pointer.current?.id !== event.pointerId) return;
    const data = movement(event);
    cancel();
    return data;
  }

  const dragging = useCallback(
    () => Boolean(pointer.current?.armed || pointer.current?.moved),
    [],
  );

  return {
    start,
    movement,
    finish,
    cancel,
    dragging,
    handlers: {
      onPointerDownCapture(event: PointerEvent<Element>) {
        if (event.isPrimary) suppressClick.current = false;
        else if (event.pointerType === "touch") {
          suppressClick.current = true;
          cancel();
        }
      },
      onPointerCancel(event: PointerEvent<Element>) {
        if (pointer.current?.id === event.pointerId) cancel();
      },
      onLostPointerCapture(event: PointerEvent<Element>) {
        if (pointer.current?.id === event.pointerId) cancel();
      },
      onClickCapture(event: React.MouseEvent<Element>) {
        if (suppressClick.current && event.detail !== 0) {
          suppressClick.current = false;
          event.stopPropagation();
        }
      },
      onContextMenu(event: React.MouseEvent<Element>) {
        if ((event.target as Element).closest("[data-canvas-drag]"))
          event.preventDefault();
      },
    },
  };
}
