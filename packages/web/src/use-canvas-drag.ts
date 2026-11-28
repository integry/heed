import { useCallback, useEffect, useRef, type PointerEvent } from "react";

const holdTime = 420;
const moveThreshold = 5;

/**
 * A press-and-drag gesture on a canvas. While a drag is in progress, Escape
 * cancels it: nothing is dropped, `clearPreview` resets the view, the release
 * that follows is ignored and does not count as a click, and `onEscape` runs.
 */
export function useCanvasDrag<Data>(
  clearPreview: () => void,
  onEscape?: () => void,
) {
  const pointer = useRef<{
    id: number;
    x: number;
    y: number;
    data: Data;
    armed: boolean;
    moved: boolean;
    captureTarget?: Element;
  } | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The element holding pointer capture, when it is not the pressed element.
  const captured = useRef<Element | null>(null);
  const suppressClick = useRef(false);
  const escapeListener = useRef<((event: KeyboardEvent) => void) | null>(null);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  function stopListening() {
    if (!escapeListener.current) return;
    window.removeEventListener("keydown", escapeListener.current, true);
    escapeListener.current = null;
  }

  const cancel = useCallback(() => {
    clearTimeout(hold.current);
    hold.current = undefined;
    stopListening();
    if (pointer.current?.moved || pointer.current?.armed)
      suppressClick.current = true;
    pointer.current = null;
    captured.current = null;
    clearPreview();
  }, [clearPreview]);

  const cancelRef = useRef(cancel);
  useEffect(() => {
    cancelRef.current = cancel;
  });

  useEffect(
    () => () => {
      clearTimeout(hold.current);
      stopListening();
    },
    [],
  );

  /** Moves capture to the gesture's stable element once it is a drag. */
  function transferCapture(current: { id: number; captureTarget?: Element }) {
    const target = current.captureTarget;
    if (!target || captured.current === target) return;
    captured.current = target;
    try {
      target.setPointerCapture?.(current.id);
    } catch {
      // The pointer is no longer active.
    }
  }

  /**
   * Starts a gesture. Once it becomes a drag, pointer capture moves to
   * `captureTarget`, an element that stays in place (such as the canvas), so
   * re-ordering the pressed element in the DOM does not end the drag. Until
   * then the pressed element keeps capture, so a plain click still lands on it.
   */
  const start = useCallback(
    (event: PointerEvent<Element>, data: Data, captureTarget?: Element) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        data,
        armed: false,
        moved: false,
        captureTarget,
      };
      pointer.current = current;
      captured.current = null;
      stopListening();
      // Capture phase on window, so the canvas's and the page's own Escape
      // handling (closing a split band, the inspector, panels) never sees it.
      const listener = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || pointer.current !== current) return;
        if (!current.armed && !current.moved) return;
        key.preventDefault();
        key.stopImmediatePropagation();
        cancelRef.current();
        onEscapeRef.current?.();
      };
      escapeListener.current = listener;
      window.addEventListener("keydown", listener, true);
      // Touch pointers already have implicit capture. Preserve native tap targets.
      if (event.pointerType === "touch") {
        hold.current = setTimeout(() => {
          hold.current = undefined;
          if (pointer.current !== current) return;
          current.armed = true;
          transferCapture(current);
        }, holdTime);
      } else {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
    },
    [],
  );

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
    transferCapture(current);
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
        // Capture moving to the canvas releases it from the pressed element.
        if (captured.current && event.target !== captured.current) return;
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
