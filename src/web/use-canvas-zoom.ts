import { select as d3Select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { useEffect, useRef } from "react";

export function useCanvasZoom(
  width: number,
  height: number,
  viewId: string | null,
  dragging: () => boolean,
) {
  const svg = useRef<SVGSVGElement>(null);
  const layer = useRef<SVGGElement>(null);
  const behavior = useRef<ZoomBehavior<SVGSVGElement, unknown>>(null);

  useEffect(() => {
    const element = svg.current!;
    const scene = layer.current!;
    const canvas = d3Select(element);
    const control = zoom<SVGSVGElement, unknown>()
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
        scene.setAttribute("transform", String(transform));
        element.classList.toggle("canvas-magnified", transform.k >= 1.8);
      });
    behavior.current = control;
    canvas.call(control);

    function singleFingerDrag(event: TouchEvent) {
      // d3 still handles pinch gestures and pans that begin before a long press.
      if (!dragging() || event.touches.length !== 1) return;
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
  }, [width, height, dragging]);

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
