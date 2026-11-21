import { pointer, select as d3Select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { useEffect, useEffectEvent, useRef } from "react";

export function useCanvasZoom<
  Canvas extends SVGSVGElement | HTMLElement = SVGSVGElement,
  Layer extends SVGElement | HTMLElement = SVGGElement,
>(
  width: number,
  height: number,
  viewId: string | null,
  dragging: () => boolean,
  {
    doubleTapZoom = true,
    x = 0,
    y = 0,
    onZoom,
    onZoomIn,
  }: {
    doubleTapZoom?: boolean;
    x?: number;
    y?: number;
    onZoom?: (scale: number) => void;
    onZoomIn?: (point: { x: number; y: number }) => void;
  } = {},
) {
  const svg = useRef<Canvas>(null);
  const layer = useRef<Layer>(null);
  const behavior = useRef<ZoomBehavior<Canvas, unknown>>(null);
  const reportsFocus = Boolean(onZoomIn);
  const zoomInto = useEffectEvent((point: { x: number; y: number }) =>
    onZoomIn?.(point),
  );

  useEffect(() => {
    const element = svg.current!;
    const scene = layer.current!;
    const canvas = d3Select(element);
    let startScale = 1;
    let zoomedIn = false;
    const control = zoom<Canvas, unknown>()
      .extent([
        [x, y],
        [x + width, y + height],
      ])
      .translateExtent([
        [x - width / 2, y - height / 2],
        [x + width * 1.5, y + height * 1.5],
      ])
      .scaleExtent([0.65, 6])
      .filter((event: MouseEvent | TouchEvent) => {
        if (event.type === "touchstart" || event.type === "wheel") return true;
        return (
          !(event as MouseEvent).button &&
          !event.ctrlKey &&
          !(event.target as Element).closest("[data-canvas-drag]")
        );
      })
      .on("start", ({ transform }) => {
        startScale = transform.k;
        zoomedIn = false;
      })
      .on("zoom", ({ transform, sourceEvent }) => {
        // Use the scene's coordinates before this zoom step moves the target.
        if (
          reportsFocus &&
          !zoomedIn &&
          transform.k >= startScale * 1.12 &&
          sourceEvent &&
          !dragging()
        ) {
          const touches = (sourceEvent as TouchEvent).touches;
          const points =
            touches?.length === 2
              ? [pointer(touches[0], scene), pointer(touches[1], scene)]
              : [pointer(sourceEvent, scene)];
          const [a, b = a] = points;
          if (a.every(Number.isFinite) && b.every(Number.isFinite)) {
            zoomedIn = true;
            zoomInto({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 });
          }
        }
        if (scene instanceof SVGElement)
          scene.setAttribute("transform", String(transform));
        else
          scene.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`;
        onZoom?.(transform.k);
      });
    behavior.current = control;
    canvas.call(control);
    // Lenses with their own double-click or double-tap meaning opt out.
    if (!doubleTapZoom) canvas.on("dblclick.zoom", null);

    function singleFingerDrag(event: Event) {
      // d3 still handles pinch gestures and pans that begin before a long press.
      if (!dragging() || (event as TouchEvent).touches.length !== 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    element.addEventListener("touchmove", singleFingerDrag, {
      capture: true,
      passive: false,
    });
    return () => {
      element.removeEventListener("touchmove", singleFingerDrag, true);
      canvas.on(".zoom", null);
      behavior.current = null;
    };
  }, [width, height, dragging, doubleTapZoom, x, y, onZoom, reportsFocus]);

  function resetZoom() {
    if (behavior.current)
      d3Select(svg.current!).call(behavior.current.transform, zoomIdentity);
  }

  useEffect(resetZoom, [viewId]);

  function zoomBy(factor: number) {
    if (behavior.current)
      d3Select(svg.current!).call(behavior.current.scaleBy, factor);
  }

  return { svg, layer, resetZoom, zoomBy };
}
