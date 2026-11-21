import { select as d3Select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { useEffect, useRef } from "react";

export function useCanvasZoom<
  Canvas extends SVGSVGElement | HTMLElement = SVGSVGElement,
  Layer extends SVGElement | HTMLElement = SVGGElement,
>(
  width: number,
  height: number,
  viewId: string | null,
  dragging: () => boolean,
  { doubleTapZoom = true }: { doubleTapZoom?: boolean } = {},
) {
  const svg = useRef<Canvas>(null);
  const layer = useRef<Layer>(null);
  const behavior = useRef<ZoomBehavior<Canvas, unknown>>(null);

  useEffect(() => {
    const element = svg.current!;
    const scene = layer.current!;
    const canvas = d3Select(element);
    const control = zoom<Canvas, unknown>()
      .extent([
        [0, 0],
        [width, height],
      ])
      .translateExtent([
        [-width / 2, -height / 2],
        [width * 1.5, height * 1.5],
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
      .on("zoom", ({ transform }) => {
        if (scene instanceof SVGElement)
          scene.setAttribute("transform", String(transform));
        else
          scene.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`;
        element.classList.toggle("canvas-magnified", transform.k >= 1.8);
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
  }, [width, height, dragging, doubleTapZoom]);

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
