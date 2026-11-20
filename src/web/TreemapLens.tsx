import { hierarchy, treemap } from "d3-hierarchy";
import { useCallback, useMemo, useState, type PointerEvent } from "react";
import type { StreamRow } from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import type { LensProps } from "./lenses";
import { HEIGHT, truncateLabel, WIDTH } from "./radar-geometry";
import { useCanvasDrag } from "./use-canvas-drag";
import { useCanvasZoom } from "./use-canvas-zoom";
import { itemStatus } from "./workspace-view";
import "./treemap.css";

type Tile = {
  id: string;
  label: string;
  item?: CanvasItem;
  project?: string;
  children: Tile[];
};

function toTiles(
  rows: readonly StreamRow<CanvasItem>[],
  showGhosts: boolean,
): Tile[] {
  return rows.flatMap(({ item, children }) => {
    const tiles = toTiles(children, showGhosts);
    return showGhosts || item.status !== "done"
      ? [{ id: item.id, label: item.title, item, children: tiles }]
      : tiles;
  });
}

export function TreemapLens({
  tree,
  projects,
  items,
  dependencies,
  selectedId,
  now,
  live,
  showGhosts,
  goalId,
  focusGoal,
  select,
  moveProject,
}: LensProps) {
  const tiles = useMemo(() => toTiles(tree, showGhosts), [tree, showGhosts]);
  function goalTile(nodes: Tile[]): Tile | undefined {
    for (const node of nodes) {
      if (node.id === goalId) return node;
      const match = goalTile(node.children);
      if (match) return match;
    }
  }
  const focused = goalId ? goalTile(tiles) : undefined;
  const goal = focused?.children.length ? focused.item : undefined;
  const layout = useMemo(() => {
    const visibleProjects = projects.filter(({ hidden }) => !hidden);
    const children =
      goal && focused
        ? focused.children
        : visibleProjects.map(({ id, name }) => {
            const children = tiles.filter(
              ({ item }) => item?.project_id === id,
            );
            return { id, label: name, project: id, children };
          });
    const root = hierarchy<Tile>({ id: "", label: "", children })
      .sum(({ item, project, children }) =>
        children.length ? 0 : (item?.priority ?? (project ? 1 : 0)),
      )
      .sort((a, b) => b.value! - a.value!);
    return treemap<Tile>()
      .size([WIDTH, HEIGHT])
      .paddingOuter(5)
      .paddingInner(4)
      .paddingTop((node) => (node.depth === 0 ? 8 : 30))(root);
  }, [goal, focused, projects, tiles]);

  const [target, setTarget] = useState<string | null>(null);
  const clearTarget = useCallback(() => setTarget(null), []);
  const drag = useCanvasDrag<CanvasItem>(clearTarget);
  const { svg, layer, zoomBy, resetZoom } = useCanvasZoom(
    WIDTH,
    HEIGHT,
    goal?.id ?? null,
    drag.dragging,
  );

  function dropProject(event: PointerEvent<SVGSVGElement>) {
    const tile = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<SVGGElement>("[data-treemap-project]");
    return tile && svg.current?.contains(tile)
      ? tile.dataset.treemapProject
      : undefined;
  }

  return (
    <div className="treemap">
      <div className="treemap-toolbar">
        {goal && (
          <>
            <button
              type="button"
              className="subtle"
              onClick={() => {
                focusGoal(goal.parent_id);
                select(null);
              }}
            >
              {goal.parent_id ? "Parent goal" : "All projects"}
            </button>
            <span aria-current="page">{goal.title}</span>
          </>
        )}
        <div
          className="radar-zoom-controls"
          role="group"
          aria-label="Treemap zoom"
        >
          <button
            type="button"
            className="subtle"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / 1.35)}
          >
            −
          </button>
          <button
            type="button"
            className="subtle"
            aria-label="Reset zoom"
            onClick={resetZoom}
          >
            Fit
          </button>
          <button
            type="button"
            className="subtle"
            aria-label="Zoom in"
            onClick={() => zoomBy(1.35)}
          >
            +
          </button>
        </div>
      </div>
      {!tiles.length && <p className="empty">No items in this view.</p>}
      <div className="treemap-chart">
        <svg
          ref={svg}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="treemap-svg"
          aria-label="Items by project and priority"
          {...drag.handlers}
          onPointerMove={(event) => {
            const item = drag.movement(event);
            if (!item) return;
            const project = dropProject(event);
            setTarget(project && project !== item.project_id ? project : null);
          }}
          onPointerUp={(event) => {
            const item = drag.finish(event);
            if (!item || !live) return;
            const project = dropProject(event);
            if (project && project !== item.project_id)
              moveProject(item.id, project);
          }}
        >
          <g ref={layer}>
            {layout
              .descendants()
              .slice(1)
              .map((node) => {
                const { id, label, item, project, children } = node.data;
                const width = node.x1 - node.x0;
                const height = node.y1 - node.y0;
                const status =
                  item && itemStatus(item, now, items, dependencies);
                const canDrag =
                  live &&
                  !goal &&
                  item?.parent_id === null &&
                  item.status !== "done";
                function activate() {
                  if (!item) return;
                  select(item.id);
                  if (children.length) focusGoal(item.id);
                }
                return (
                  <g
                    key={JSON.stringify(
                      node.ancestors().map(({ data }) => data.id),
                    )}
                    transform={`translate(${node.x0},${node.y0})`}
                    className="treemap-tile"
                    data-treemap-project={project ?? item?.project_id}
                    data-status={status}
                    data-project={project !== undefined}
                    data-target={project !== undefined && project === target}
                    data-canvas-drag={canDrag || undefined}
                    role={item ? "button" : undefined}
                    aria-label={item ? `${label}, ${status}` : undefined}
                    aria-pressed={item ? selectedId === id : undefined}
                    tabIndex={item ? 0 : undefined}
                    onPointerDown={
                      canDrag ? (event) => drag.start(event, item) : undefined
                    }
                    onClick={activate}
                    onKeyDown={(event) => {
                      if (
                        item &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        activate();
                      }
                    }}
                  >
                    <rect width={width} height={height} rx={4} />
                    {width >= 36 && height >= 20 && (
                      <text x={7} y={21}>
                        {truncateLabel(label, width - 19, 19)}
                      </text>
                    )}
                  </g>
                );
              })}
          </g>
        </svg>
      </div>
    </div>
  );
}
