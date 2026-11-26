import { nestProblem, nestTarget } from "./radar-nesting";
import { shapeTop } from "./radar-shapes";
import {
  INBOX_PROJECT_ID,
  itemShape,
  projectCode,
  projectColor,
  readTags,
} from "@heedwork/core";
import {
  useCallback,
  useId,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  effectiveSchedule,
  radarBandsFor,
  radarSubgroups,
  radarTimesToday,
  rollUpRing,
  type RadarSubgroup,
  type StreamRow,
} from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import type { Project, RadarBand } from "@heedwork/core";
import type { LensProps } from "./lenses";
import { RadarBubble, type Bubble } from "./RadarBubble";
import { itemRing } from "./workspace-view";
import {
  bubbleRadius,
  bandBounds,
  cellBounds,
  cellPoint,
  CENTER,
  GOAL_CHIP_Y,
  GOAL_RADIUS,
  goalPoint,
  goalPosition,
  HEIGHT,
  layoutGoal,
  layoutRadar,
  labelWidth,
  MIN_FIELD_SCALE,
  polar,
  priorityForRadius,
  RADAR_BANDS,
  RADAR_LABELS,
  RADAR_LABEL_FONT,
  RADAR_RADIUS,
  radarBoundaries,
  radarDrop,
  radarViewport,
  readRadarPosition,
  ringLabel,
  scheduleForRing,
  targetCell,
  truncateLabel,
  WIDTH,
  type Cell,
  type Point,
  type RadialBounds,
} from "./radar-geometry";
import { outsideLabels, radarTimeBadge, type LabelBox } from "./radar-labels";
import { useCanvasDrag } from "./use-canvas-drag";
import { useCanvasZoom } from "./use-canvas-zoom";
import "./radar.css";

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const translate = ({ x, y }: Point) => `translate(${x},${y})`;

type Gesture = {
  id: string;
  kind: "move" | "resize";
  start: Point;
  origin: Point;
  radius: number;
};
type Preview = { id: string; point: Point; priority?: number };
type Subring = RadarSubgroup & RadialBounds;
type FinishStatus = "done" | "cancelled";
/** A message under the radar; `undo` names an item whose finish can be undone. */
type DropMessage = { text: string; undo?: string };

const FINISH_TARGETS = [
  { status: "done", glyph: "✓", label: "Done" },
  { status: "cancelled", glyph: "⊘", label: "Won't do" },
] as const;
const FINISH_MESSAGE_MS = 8000;
const GOAL_CHIP_HALF_HEIGHT = 18;

const ignore = () => {};
const isOpen = (item: CanvasItem) =>
  item.status !== "done" && item.status !== "cancelled";

/** The value of a drop zone's data attribute under the pointer, if any. */
function dropZoneAt(
  event: PointerEvent,
  attribute: "drop-parent" | "drop-finish",
): string | null {
  // jsdom has no elementsFromPoint.
  const under =
    document.elementsFromPoint?.(event.clientX, event.clientY) ?? [];
  for (const element of under) {
    const zone = element.closest(`[data-${attribute}]`);
    if (zone) return zone.getAttribute(`data-${attribute}`);
  }
  return null;
}

function fitOrderedBubbles(
  ordered: { bubble: Bubble; edgeClearance: number }[],
) {
  let fit = 1;
  const padded = ordered.map(({ bubble, edgeClearance }) => {
    const radius = bubble.radius + Math.min(2, bubble.scale * 8);
    fit = Math.min(fit, edgeClearance / radius);
    return { point: bubble.point, radius };
  });
  for (const [index, a] of padded.entries()) {
    for (let next = index + 1; next < padded.length; next++) {
      const b = padded[next];
      fit = Math.min(fit, distance(a.point, b.point) / (a.radius + b.radius));
    }
  }
  if (fit < 1) {
    for (const { bubble } of ordered) {
      bubble.radius *= fit;
      bubble.scale *= fit;
    }
  }
}

function subgroupLabel({ inner, outer }: RadialBounds) {
  return polar(-Math.PI / 2, (inner + outer) / 2);
}

function pathForCell(cell: Cell) {
  const { inner, outer, start, span } = cellBounds(cell);
  // An SVG arc whose start and end coincide is empty.
  const end = start + Math.min(span, 2 * Math.PI - 0.00001);
  const a = polar(start, outer);
  const b = polar(end, outer);
  const c = polar(end, inner);
  const d = polar(start, inner);
  const large = Number(span > Math.PI);
  return `M ${a.x} ${a.y} A ${outer} ${outer} 0 ${large} 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${inner} ${inner} 0 ${large} 0 ${d.x} ${d.y} Z`;
}

/** The time chip under a point inside an item, above the finish targets. */
function goalDropTarget(point: Point) {
  if (Math.abs(point.y - GOAL_CHIP_Y) > GOAL_CHIP_HALF_HEIGHT + 2)
    return undefined;
  return RADAR_BANDS.find(
    (_, index) => Math.abs(point.x - (175 + index * 150)) <= 67,
  );
}

function RadarField({
  projects,
  highlight,
  scale,
  showLabels,
  edges,
  subrings,
}: {
  projects: readonly Project[];
  highlight: Cell | null;
  scale: number;
  showLabels: boolean;
  edges: number[];
  subrings: readonly Subring[];
}) {
  const sectors = projects.length || 1;
  const labelId = useId();
  const font = RADAR_LABEL_FONT / scale;
  const labelRadius = RADAR_RADIUS + 16 / scale;
  return (
    <g aria-hidden="true" className="radar-field">
      {[...RADAR_BANDS].reverse().map((band) => {
        const { outer } = bandBounds(band, edges);
        return (
          <circle
            key={band}
            cx={CENTER.x}
            cy={CENTER.y}
            r={outer}
            className="radar-band"
            data-band={band}
          />
        );
      })}
      {subrings.slice(0, -1).map(({ id, outer }) => (
        <circle
          key={id}
          cx={CENTER.x}
          cy={CENTER.y}
          r={outer}
          className="radar-subring"
        />
      ))}
      {projects.map((project, sector) => {
        const { start, span } = cellBounds({
          band: "backlog",
          sector,
          sectors,
        });
        const edge = polar(start, RADAR_RADIUS);
        const middle = start + span / 2;
        const halfArc = Math.min(span * 0.45, Math.PI / 3);
        const reverse = Math.sin(middle) > 0;
        const from = polar(
          middle + (reverse ? halfArc : -halfArc),
          labelRadius,
        );
        const to = polar(middle + (reverse ? -halfArc : halfArc), labelRadius);
        const id = `${labelId}-${sector}`;
        const label = truncateLabel(
          project.name,
          halfArc * 2 * labelRadius,
          font,
        );
        return (
          <g key={project.id}>
            {sectors > 1 && (
              <line
                x1={CENTER.x}
                y1={CENTER.y}
                x2={edge.x}
                y2={edge.y}
                className="radar-sector-line"
              />
            )}
            {showLabels && sectors > 1 && (
              <>
                <path
                  id={id}
                  d={`M ${from.x} ${from.y} A ${labelRadius} ${labelRadius} 0 0 ${Number(!reverse)} ${to.x} ${to.y}`}
                  fill="none"
                />
                <text
                  textAnchor="middle"
                  fontSize={font}
                  className="radar-project-label"
                >
                  <textPath href={`#${id}`} startOffset="50%">
                    {label}
                  </textPath>
                  <title>{project.name}</title>
                </text>
              </>
            )}
          </g>
        );
      })}
      {highlight && (
        <path d={pathForCell(highlight)} className="radar-drop-cell" />
      )}
    </g>
  );
}

function edgePath(source: Bubble, target: Bubble) {
  const length = distance(source.point, target.point);
  if (!length) return undefined;
  const x = (target.point.x - source.point.x) / length;
  const y = (target.point.y - source.point.y) / length;
  if (length - source.radius - target.radius >= 14) {
    const start = source.radius + 5;
    const end = target.radius + 6;
    return `M ${source.point.x + x * start} ${source.point.y + y * start} L ${target.point.x - x * end} ${target.point.y - y * end}`;
  }
  const start = source.radius + 4;
  const end = target.radius + 5;
  const bend = Math.max(start, end) + 18;
  const middle = {
    x: (source.point.x + target.point.x) / 2,
    y: (source.point.y + target.point.y) / 2,
  };
  return `M ${source.point.x - y * start} ${source.point.y + x * start} Q ${middle.x - y * bend} ${middle.y + x * bend} ${target.point.x - y * end} ${target.point.y + x * end}`;
}

export function isRadarRowVisible(item: CanvasItem, showGhosts: boolean) {
  return showGhosts || item.status !== "done";
}

function radarTree(
  tree: readonly StreamRow<CanvasItem>[],
  showGhosts: boolean,
) {
  const rows = new Map<string, StreamRow<CanvasItem>>();
  const parents = new Map<string, string | null>();
  function visit(
    children: readonly StreamRow<CanvasItem>[],
    parent: string | null,
  ): StreamRow<CanvasItem>[] {
    return children.flatMap(({ item, children }) => {
      if (!isRadarRowVisible(item, showGhosts)) return visit(children, parent);
      parents.set(item.id, parent);
      const row = { item, children: visit(children, item.id) };
      rows.set(item.id, row);
      return [row];
    });
  }
  return { roots: visit(tree, null), rows, parents };
}

export function RadarLens({
  tree,
  projects: allProjects,
  items,
  dependencies,
  selectedId,
  goalId,
  now,
  timezone,
  live,
  showGhosts,
  select,
  radarZoom,
  focusGoal,
  openDependencies,
  moveRadar,
  reschedule,
  setPriority,
  reparent,
  finish,
  undoFinish,
  finishTargetsShown,
  tagShapes,
}: LensProps) {
  // Projects other than Inbox carry a colour and a badge on their bubbles.
  const identities = useMemo(
    () =>
      new Map(
        allProjects
          .filter(({ id }) => id !== INBOX_PROJECT_ID)
          .map((project) => [
            project.id,
            { color: projectColor(project), code: projectCode(project) },
          ]),
      ),
    [allProjects],
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const clearPreview = useCallback(() => setPreview(null), []);
  const drag = useCanvasDrag<Gesture>(clearPreview);
  const { cancel: cancelGesture, start: startDrag } = drag;
  const [tooltip, setTooltip] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [splitBand, setSplitBand] = useState<RadarBand | null>(null);
  const chart = useRef<HTMLDivElement>(null);
  const [{ width, height }, setSize] = useState({
    width: WIDTH,
    height: HEIGHT,
  });
  useLayoutEffect(() => {
    if (!chart.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(chart.current);
    return () => observer.disconnect();
  }, []);
  const [dropMessage, setDropMessage] = useState<DropMessage | null>(null);
  useEffect(() => {
    if (!dropMessage?.undo) return;
    const timer = setTimeout(() => setDropMessage(null), FINISH_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [dropMessage]);
  // The finish target under the pointer while moving a bubble.
  const [finishTarget, setFinishTarget] = useState<FinishStatus | null>(null);
  // The zoom transform at the start of a gesture, for the drag layer.
  const [dragTransform, setDragTransform] = useState<string>();
  // A breadcrumb under the pointer while dragging inside an item: an item ID,
  // or "" for the top level.
  const [crumbTarget, setCrumbTarget] = useState<string | null>(null);
  const arrowId = useId();
  const projects = useMemo(
    () => allProjects.filter(({ hidden }) => hidden === 0),
    [allProjects],
  );
  const projectIds = useMemo(() => projects.map(({ id }) => id), [projects]);
  const { roots, rows, parents } = useMemo(
    () => radarTree(tree, showGhosts),
    [tree, showGhosts],
  );
  const requestedGoal = goalId ? rows.get(goalId) : undefined;
  const goal = requestedGoal?.children.length ? requestedGoal : undefined;
  const split = goal ? null : splitBand;
  const entries = goal?.children ?? roots;
  const viewport = radarViewport(width, height, Boolean(goal));
  const labelScale = viewport.scale * zoom;
  const layoutKey = goal ? `radar-goal:${goal.item.id}` : "radar";
  const bandById = useMemo(
    () =>
      radarBandsFor(
        [...rows.values()].map(({ item }) => item),
        items,
        now,
        timezone,
      ),
    [rows, items, now, timezone],
  );
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    [timezone],
  );

  const setup = useMemo(
    () =>
      entries
        .flatMap(({ item }) => {
          const sector = projectIds.indexOf(item.project_id);
          if (sector === -1) return [];
          return [
            {
              item,
              id: item.id,
              priority: item.priority,
              position: readRadarPosition(item.layout_pos, item.id, layoutKey),
              cell: {
                band: bandById.get(item.id)!,
                sector,
                sectors: projects.length,
              },
            },
          ];
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
    [entries, projectIds, layoutKey, bandById, projects.length],
  );
  const signature = useMemo(
    () =>
      JSON.stringify([
        layoutKey,
        projectIds,
        goal
          ? setup.map(({ id }) => id)
          : [
              viewport.scale,
              setup.map(({ id, cell, priority, position }) => [
                id,
                cell.band,
                cell.sector,
                priority,
                position,
              ]),
            ],
      ]),
    [layoutKey, projectIds, goal, setup, viewport.scale],
  );
  const buildLayout = () => ({
    signature,
    radar: goal ? undefined : layoutRadar(setup, viewport.scale),
    packed: goal ? layoutGoal(setup) : undefined,
  });
  const [layout, setLayout] = useState(buildLayout);
  if (layout.signature !== signature) setLayout(buildLayout());

  const visibleBands = layout.radar?.visibleBands ?? [];
  const splitView = useMemo(() => {
    const viewItems = setup.map(({ item }) => item);
    const splitItems = setup
      .filter(({ cell }) => cell.band === split)
      .map(({ item }) => item);
    const groups = split
      ? radarSubgroups(split, splitItems, items, projects, now, timezone)
      : [];
    const assigned = new Set(groups.flatMap(({ itemIds }) => itemIds));
    const unassigned = splitItems
      .filter(({ id }) => !assigned.has(id))
      .map(({ id }) => id);
    if (unassigned.length) {
      // Give ghosts outside the current date groups their own packing space.
      // Each subring preserves the overview packing clearance within its bounds.
      groups.push({
        id: "unassigned",
        label: split === "today" ? "Earlier completions" : "Other items",
        itemIds: unassigned,
      });
    }
    const edges = radarBoundaries(split, groups.length);
    const subrings: Subring[] = [];
    const membership = new Map<
      string,
      { radial: Subring; orderedRadius?: number }
    >();
    if (split) {
      const { inner, outer } = bandBounds(split, edges);
      const step = (outer - inner) / groups.length;
      for (const [index, group] of groups.entries()) {
        const radial = {
          ...group,
          inner: inner + index * step,
          outer: inner + (index + 1) * step,
        };
        subrings.push(radial);
        group.itemIds.forEach((id, rank) =>
          membership.set(id, {
            radial,
            orderedRadius:
              split === "today" && group.id === "next"
                ? (rank + 0.5) / group.itemIds.length
                : undefined,
          }),
        );
      }
    }
    const markers = new Map<string, string[]>();
    if (split === "today") {
      for (const { item, time } of radarTimesToday(viewItems, now, timezone)) {
        const stamp = timeFormatter.format(time);
        if (!markers.has(stamp)) markers.set(stamp, []);
        markers.get(stamp)!.push(item.title);
      }
    }
    return { edges, membership, subrings, markers };
  }, [split, setup, items, projects, now, timezone, timeFormatter]);
  const { edges, subrings, markers } = splitView;
  const shownBands = split ? RADAR_BANDS : visibleBands;
  const rim = useMemo(
    () =>
      [...markers].map(([stamp, titles]) => {
        const [hour, minute] = stamp.split(":").map(Number);
        const angle = ((hour + minute / 60) * Math.PI) / 12 - Math.PI / 2;
        const { outer } = bandBounds("today", edges);
        return {
          stamp,
          titles,
          tick: polar(angle, outer),
          end: polar(angle, outer + 5 / labelScale),
          point: polar(angle, outer + 16 / labelScale),
        };
      }),
    [markers, edges, labelScale],
  );
  const allItems = useMemo(() => [...items.values()], [items]);
  const bubbles = useMemo(() => {
    const ordered: { bubble: Bubble; edgeClearance: number }[] = [];
    const projected = setup.flatMap(({ item, cell, position }) => {
      const packed = layout.packed?.get(item.id);
      const plotted = layout.radar?.placements.get(item.id);
      const placement = goal ? packed : plotted;
      if (!placement) return [];
      let { scale } = placement;
      const size = bubbleRadius(item.priority);
      const group = splitView.membership.get(item.id);
      const radial = group?.radial ?? bandBounds(cell.band, splitView.edges);
      const base = bandBounds(cell.band);
      const width = radial.outer - radial.inner;
      if (split && !goal) {
        // A band moved inward can lose more tangential than radial space.
        scale *= Math.min(
          1,
          width / (base.outer - base.inner),
          base.inner > 0 ? radial.inner / base.inner : 1,
        );
      }
      const radius = size * scale;
      const point =
        "point" in placement
          ? position
            ? goalPoint(position, radius)
            : placement.point
          : cellPoint(
              { ...cell, radial },
              {
                angle: placement.position.angle,
                radius: group?.orderedRadius ?? placement.position.radius,
              },
            );

      const ring = itemRing(item, now, items, dependencies);
      const rollup =
        item.progress.total > 0
          ? rollUpRing(item, allItems, dependencies, now)
          : null;
      const bubble: Bubble = {
        item,
        point,
        radius,
        scale,
        ring,
        rollup,
        opensGoal: Boolean(rows.get(item.id)?.children.length),
      };
      if (group?.orderedRadius !== undefined) {
        ordered.push({
          bubble,
          edgeClearance:
            width * Math.min(group.orderedRadius, 1 - group.orderedRadius),
        });
      }
      return [bubble];
    });
    // Rank changes the packed distances, so fit the reordered group as a unit.
    fitOrderedBubbles(ordered);
    return projected;
  }, [
    setup,
    layout,
    goal,
    now,
    items,
    dependencies,
    projects,
    rows,
    allItems,
    split,
    splitView,
  ]);
  const callouts = useMemo(() => {
    if (goal || labelScale < MIN_FIELD_SCALE) return;
    const reserved: LabelBox[] = [];
    // Keep callouts off the project badges on top of bubbles.
    for (const { item, point, radius } of bubbles) {
      const identity = identities.get(item.project_id);
      if (!identity || radius * labelScale < 14) continue;
      const top = shapeTop(itemShape(readTags(item.tags), tagShapes), radius);
      reserved.push({
        x: point.x,
        y: point.y - top - 3 / labelScale,
        halfWidth: (identity.code.length * 4 + 8) / labelScale,
        halfHeight: 8 / labelScale,
      });
    }
    if (split) {
      const font = RADAR_LABEL_FONT / labelScale;
      for (const { point, text } of [
        ...shownBands.map((band) => ringLabel(band, edges, band === split)),
        ...subrings.map((group) => ({
          point: subgroupLabel(group),
          text: group.label,
        })),
        ...rim.map(({ point, stamp }) => ({ point, text: stamp })),
      ]) {
        reserved.push({
          ...point,
          halfWidth: labelWidth(text, font) / 2 + 5 / labelScale,
          halfHeight: font / 2 + 5 / labelScale,
        });
      }
    }
    return outsideLabels(
      bubbles.map(({ item, point, radius }) => ({
        id: item.id,
        title: item.title,
        point,
        radius,
        ...radarTimeBadge(item, timeFormatter),
      })),
      labelScale,
      split ? [] : visibleBands,
      reserved,
    );
  }, [
    bubbles,
    goal,
    labelScale,
    timeFormatter,
    visibleBands,
    split,
    shownBands,
    edges,
    subrings,
    rim,
    identities,
    tagShapes,
  ]);
  const drawOrder = useMemo(
    () =>
      [...bubbles].sort(
        (a, b) =>
          Number(a.item.id === selectedId) - Number(b.item.id === selectedId),
      ),
    [bubbles, selectedId],
  );
  const displayed = drawOrder.map((bubble) => {
    if (preview?.id !== bubble.item.id) return bubble;
    return {
      ...bubble,
      point: preview.point,
      radius:
        preview.priority === undefined
          ? bubble.radius
          : bubbleRadius(preview.priority) * bubble.scale,
    };
  });
  const bubbleById = new Map(
    displayed.map((bubble) => [bubble.item.id, bubble]),
  );
  const path: StreamRow<CanvasItem>[] = [];
  for (let current = goal; current;) {
    path.unshift(current);
    const parent = parents.get(current.item.id);
    current = parent ? rows.get(parent) : undefined;
  }

  const { svg, layer, zoomBy, resetZoom } = useCanvasZoom(
    viewport.width,
    viewport.height,
    goal?.item.id ?? null,
    drag.dragging,
    {
      x: viewport.x,
      y: viewport.y,
      onZoom: setZoom,
      onZoomIn: (point) => {
        if (goal) return;
        const cell = targetCell(point, Math.max(1, projects.length), edges);
        if (cell) setSplitBand(cell.band);
      },
    },
  );

  const applyZoom = useEffectEvent((band: RadarBand | null) => {
    resetZoom();
    setSplitBand(band);
  });
  useEffect(() => {
    if (radarZoom) applyZoom(radarZoom.band);
  }, [radarZoom]);

  function scenePoint(event: PointerEvent): Point {
    const matrix = layer.current?.getScreenCTM();
    return matrix
      ? new DOMPoint(event.clientX, event.clientY).matrixTransform(
          matrix.inverse(),
        )
      : { x: event.clientX, y: event.clientY };
  }

  const onGesture = useCallback(
    (
      event: PointerEvent<SVGElement>,
      bubble: Bubble,
      kind: Gesture["kind"],
    ) => {
      setDropMessage(null);
      setFinishTarget(null);
      setDragTransform(layer.current?.getAttribute("transform") ?? undefined);
      // Capture on the canvas: the dragged bubble is re-ordered to the top.
      startDrag(
        event,
        {
          id: bubble.item.id,
          kind,
          start: scenePoint(event),
          origin: bubble.point,
          radius: bubble.radius,
        },
        svg.current ?? undefined,
      );
    },
    [startDrag, layer, svg],
  );

  function dragPreview(event: PointerEvent<SVGSVGElement>, active?: Gesture) {
    if (!active) return;
    const bubble = bubbles.find(({ item }) => item.id === active.id);
    if (!bubble) return;
    const cursor = scenePoint(event);
    const point = {
      x: active.origin.x + cursor.x - active.start.x,
      y: active.origin.y + cursor.y - active.start.y,
    };
    if (active.kind === "move")
      return { bubble, next: { id: active.id, point } };
    const radius =
      active.radius +
      distance(cursor, active.origin) -
      distance(active.start, active.origin);
    return {
      bubble,
      next: {
        id: active.id,
        point: active.origin,
        priority: priorityForRadius(radius / bubble.scale),
      },
    };
  }

  function canApplySchedule(
    item: CanvasItem,
    target: RadarBand,
    date: string | null | undefined,
    dropTime: number,
  ) {
    if (date === undefined) return true;

    const proposed = { ...item, scheduled_on: date };
    const open = item.status !== "done" && item.status !== "cancelled";
    if (
      open &&
      radarBandsFor([proposed], items, dropTime, timezone).get(item.id) ===
        target
    )
      return true;

    let reason;
    if (!open) reason = "it is no longer open";
    else if (item.status === "active") reason = "it is active";
    else if (date === null && effectiveSchedule(proposed, items) !== null)
      reason = "it would inherit a schedule from an ancestor";
    else if (target === "backlog") reason = "it still has a time set";
    else reason = "its time keeps it in Today";
    setDropMessage({
      text: `${item.title} can’t move to ${RADAR_LABELS[target]} because ${reason}.`,
    });
    return false;
  }

  function dropTarget(point: Point) {
    const cell = targetCell(point, projects.length, edges);
    const radialDistance = distance(point, CENTER);
    const group =
      cell?.band === split
        ? subrings.find(({ outer }) => radialDistance <= outer + 1e-9)
        : undefined;
    return {
      cell: cell && group ? { ...cell, radial: group } : cell,
      day: group?.day,
    };
  }

  /** The breadcrumb under the pointer, as a parent ID ("" for the top level). */
  function crumbAt(event: PointerEvent): string | null {
    return goal ? dropZoneAt(event, "drop-parent") : null;
  }

  /** Whether an item can be finished from the Done or Won't do targets. */
  function canFinish(id: string) {
    const item = items.get(id);
    return Boolean(live && finish && item && isOpen(item));
  }

  /** The finish target under the pointer for a bubble being moved. */
  function finishAt(event: PointerEvent, id: string): FinishStatus | null {
    if (!canFinish(id)) return null;
    const status = dropZoneAt(event, "drop-finish");
    return status === "done" || status === "cancelled" ? status : null;
  }

  function finishItem(item: CanvasItem, status: FinishStatus) {
    finish!(item.id, status);
    const open = item.progress.total - item.progress.done;
    const children =
      open > 0
        ? ` ${open} ${open === 1 ? "sub-item is" : "sub-items are"} still open.`
        : "";
    setDropMessage({
      text: `Marked ${item.title} ${status === "done" ? "done" : "won't do"}.${children}`,
      undo: item.id,
    });
  }

  /** Moves an item under a new parent (null: top level) if the tree allows it. */
  function nestUnder(item: CanvasItem, parentId: string | null) {
    if (!reparent || parentId === item.parent_id) return false;
    const problem = nestProblem(item, parentId, items);
    if (problem) {
      setDropMessage({
        text: `${item.title} can’t move there because ${problem}.`,
      });
      return true;
    }
    reparent(item.id, parentId);
    const parent = parentId === null ? undefined : items.get(parentId);
    setDropMessage({
      text: parent
        ? `Moved ${item.title} into ${parent.title}.`
        : `Moved ${item.title} to the top level.`,
    });
    return true;
  }

  function release(event: PointerEvent<SVGSVGElement>) {
    const result = dragPreview(event, drag.finish(event));
    setCrumbTarget(null);
    setFinishTarget(null);
    if (!result || !live) return;
    const { next, bubble } = result;
    const { item } = bubble;
    // A finish target wins over every other reading of the drop.
    const finishing =
      next.priority === undefined ? finishAt(event, item.id) : null;
    if (finishing) {
      finishItem(item, finishing);
      return;
    }
    const dropTime = Math.max(now, Date.now());
    const crumb = next.priority === undefined ? crumbAt(event) : null;
    const target =
      next.priority === undefined
        ? nestTarget(next.point, displayed, item.id)
        : undefined;
    if (next.priority !== undefined) {
      if (item.priority !== next.priority) setPriority(item.id, next.priority);
    } else if (crumb !== null) {
      nestUnder(item, crumb || null);
    } else if (target && nestUnder(item, target.item.id)) {
      return;
    } else if (goal) {
      const target = goalDropTarget(next.point);
      const currentBand = bandById.get(item.id);
      if (target && target !== currentBand) {
        const date = scheduleForRing(target, dropTime, timezone);
        if (canApplySchedule(item, target, date, dropTime))
          reschedule(item.id, date);
      } else if (distance(next.point, CENTER) <= GOAL_RADIUS) {
        moveRadar(
          item.id,
          {
            position: goalPosition(next.point, bubble.radius),
            scheduled_on: undefined,
            project: undefined,
          },
          layoutKey,
        );
      } else {
        // Dropped outside the item's circle: up one level.
        nestUnder(item, goal.item.parent_id);
      }
    } else {
      const { cell, day } = dropTarget(next.point);
      const drop = radarDrop(
        next.point,
        projectIds,
        {
          band: bandById.get(item.id)!,
          project: item.project_id,
          topLevel: item.parent_id === null,
        },
        dropTime,
        timezone,
        cell,
        day,
      );
      if (!drop) return;
      const { band: target, ...placement } = drop;
      if (canApplySchedule(item, target, placement.scheduled_on, dropTime))
        moveRadar(item.id, placement);
    }
  }

  const navigate = useCallback(
    (id: string | null) => {
      focusGoal(id);
      setTooltip(null);
      setDropMessage(null);
      cancelGesture();
    },
    [focusGoal, cancelGesture],
  );

  const openBubbleDetails = useCallback(
    (bubble: Bubble) => {
      select(bubble.item.id);
      if (bubble.opensGoal) navigate(bubble.item.id);
    },
    [select, navigate],
  );

  function goBack(id: string | null) {
    const index =
      id === null ? -1 : path.findIndex(({ item }) => item.id === id);
    select(path[index + 1]?.item.id ?? null);
    navigate(id);
  }

  const moving = preview && preview.priority === undefined;
  // The targets finish the bubble being moved or, at rest, the selected item;
  // a priority resize offers neither.
  const finishId = moving ? preview.id : preview ? null : selectedId;
  const finishSubject =
    finishId !== null && canFinish(finishId) ? items.get(finishId) : undefined;
  const showFinish = Boolean(moving && finishSubject);
  const finishing = showFinish ? finishTarget : null;
  const reportFinishTargets = useEffectEvent((shown: boolean) =>
    finishTargetsShown?.(shown),
  );
  // Before paint, so question cards never cover the targets for a frame.
  useLayoutEffect(() => {
    if (!showFinish) return;
    reportFinishTargets(true);
    return () => reportFinishTargets(false);
  }, [showFinish]);
  const nestCandidate =
    moving && reparent && crumbTarget === null && !finishing
      ? nestTarget(preview.point, displayed, preview.id)
      : undefined;
  const nestBlocked =
    nestCandidate &&
    (() => {
      const dragged = items.get(preview!.id);
      return dragged
        ? nestProblem(dragged, nestCandidate.item.id, items) !== null
        : true;
    })();
  const liftsOut =
    Boolean(goal && moving && reparent && crumbTarget === null) &&
    !finishing &&
    !nestCandidate &&
    distance(preview!.point, CENTER) > GOAL_RADIUS &&
    !goalDropTarget(preview!.point);
  let highlight: Cell | null = null;
  if (!goal && moving && !nestCandidate && !finishing) {
    const { cell } = dropTarget(preview.point);
    const item = bubbleById.get(preview.id)?.item;
    if (
      cell &&
      item &&
      (item.parent_id === null || item.project_id === projectIds[cell.sector])
    )
      highlight = cell;
  }

  const font = RADAR_LABEL_FONT / labelScale;

  function toggleBand(band: RadarBand) {
    setSplitBand((previous) => (previous === band ? null : band));
    setTooltip(null);
    setDropMessage(null);
  }

  return (
    <div
      className="radar"
      onKeyDown={(event) => {
        if (event.key === "Escape" && split) {
          event.stopPropagation();
          setSplitBand(null);
        }
      }}
    >
      <div className="radar-toolbar">
        {goal && (
          <nav className="radar-breadcrumb" aria-label="Goal breadcrumb">
            <button
              className="subtle"
              type="button"
              data-drop-parent=""
              data-drop-target={crumbTarget === ""}
              onClick={() => goBack(null)}
            >
              All projects
            </button>
            {path.map(({ item }) =>
              item.id === goal.item.id ? (
                <span key={item.id} aria-current="page">
                  {item.title}
                </span>
              ) : (
                <button
                  key={item.id}
                  className="subtle"
                  type="button"
                  data-drop-parent={item.id}
                  data-drop-target={crumbTarget === item.id}
                  onClick={() => goBack(item.id)}
                >
                  {item.title}
                </button>
              ),
            )}
          </nav>
        )}
        {!goal && RADAR_BANDS.some((band) => !visibleBands.includes(band)) && (
          <div
            className="radar-band-controls"
            role="group"
            aria-label="Time bands"
          >
            {RADAR_BANDS.filter((band) => !visibleBands.includes(band)).map(
              (band) => (
                <button
                  key={band}
                  className="subtle"
                  type="button"
                  aria-expanded={band === split}
                  onClick={() => toggleBand(band)}
                >
                  {RADAR_LABELS[band]}
                </button>
              ),
            )}
          </div>
        )}
        <div
          className="radar-zoom-controls"
          aria-label="Radar zoom"
          role="group"
        >
          {goal && openDependencies && (
            <button className="subtle" type="button" onClick={openDependencies}>
              Dependencies
            </button>
          )}
          <button
            className="subtle"
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / 1.35)}
          >
            −
          </button>
          <button
            className="subtle"
            type="button"
            aria-label="Reset zoom"
            onClick={() => {
              setSplitBand(null);
              resetZoom();
            }}
          >
            Fit
          </button>
          <button
            className="subtle"
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomBy(1.35)}
          >
            +
          </button>
        </div>
      </div>
      <div
        ref={chart}
        className="radar-chart"
        data-dragging={Boolean(preview)}
        data-finish-buttons={(finishSubject && !showFinish) || undefined}
        // Overlays over the chart's foot (inspector, question cards) sit above
        // the finish targets and the drop message while either is shown.
        data-bottom-row={Boolean(finishSubject || dropMessage) || undefined}
      >
        <svg
          ref={svg}
          className="radar-svg"
          viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
          aria-label={
            goal
              ? `Items in ${goal.item.title}`
              : "Attention field. Items by time ring and project."
          }
          {...drag.handlers}
          onPointerMove={(event) => {
            const result = dragPreview(event, drag.movement(event));
            if (result) {
              setPreview(result.next);
              if (result.next.priority === undefined) {
                const over = finishAt(event, result.next.id);
                setFinishTarget(over);
                setCrumbTarget(over ? null : crumbAt(event));
              }
            }
          }}
          onPointerUp={release}
          onClick={() => select(null)}
        >
          <defs>
            <marker
              id={arrowId}
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
              viewBox="0 0 7 7"
              className="radar-arrow"
            >
              <path d="M 0 0 L 7 3.5 L 0 7 Z" />
            </marker>
          </defs>
          <g ref={layer}>
            {goal ? (
              <g aria-hidden="true">
                <circle
                  cx={CENTER.x}
                  cy={CENTER.y}
                  r={GOAL_RADIUS}
                  className="radar-goal-field"
                  data-lift={liftsOut}
                />
                {dependencies.map(({ item_id, blocked_by_id }) => {
                  const source = bubbleById.get(blocked_by_id);
                  const target = bubbleById.get(item_id);
                  if (
                    !source ||
                    !target ||
                    source.item.parent_id !== target.item.parent_id
                  )
                    return null;
                  const d = edgePath(source, target);
                  return (
                    d && (
                      <path
                        key={JSON.stringify([item_id, blocked_by_id])}
                        className="radar-edge"
                        d={d}
                        markerEnd={`url(#${arrowId})`}
                      />
                    )
                  );
                })}
                {moving &&
                  RADAR_BANDS.map((band, index) => (
                    <g
                      key={band}
                      transform={translate({
                        x: 175 + index * 150,
                        y: GOAL_CHIP_Y,
                      })}
                      className="radar-goal-drop"
                      data-target={
                        !finishing && goalDropTarget(preview.point) === band
                      }
                    >
                      <rect
                        x={-67}
                        y={-GOAL_CHIP_HALF_HEIGHT}
                        width={134}
                        height={GOAL_CHIP_HALF_HEIGHT * 2}
                        rx={9}
                      />
                      <text textAnchor="middle" dy="0.35em">
                        {RADAR_LABELS[band]}
                      </text>
                    </g>
                  ))}
              </g>
            ) : (
              <RadarField
                projects={projects}
                highlight={highlight}
                scale={labelScale}
                showLabels={viewport.scale >= MIN_FIELD_SCALE}
                edges={edges}
                subrings={subrings}
              />
            )}
            {nestCandidate && (
              <circle
                aria-hidden="true"
                className="radar-nest-target"
                data-blocked={nestBlocked}
                cx={nestCandidate.point.x}
                cy={nestCandidate.point.y}
                r={nestCandidate.radius + 6 / labelScale}
              />
            )}
            {(preview
              ? // The bubble being dragged stays on top of the one it is dropped on.
                [
                  ...displayed.filter(({ item }) => item.id !== preview.id),
                  ...displayed.filter(({ item }) => item.id === preview.id),
                ]
              : displayed
            ).map((bubble) => (
              <RadarBubble
                key={bubble.item.id}
                bubble={bubble}
                project={identities.get(bubble.item.project_id)}
                shape={itemShape(readTags(bubble.item.tags), tagShapes)}
                selected={selectedId === bubble.item.id}
                live={live}
                now={now}
                labelScale={labelScale}
                outsideLabel={
                  preview ? undefined : callouts?.get(bubble.item.id)
                }
                timeFormatter={timeFormatter}
                onActivate={openBubbleDetails}
                onGesture={onGesture}
                onPriority={setPriority}
                onTooltip={setTooltip}
                finishing={
                  bubble.item.id === preview?.id
                    ? (finishing ?? undefined)
                    : undefined
                }
              />
            ))}
            {!goal && (
              <>
                {subrings.map((group) => {
                  const { x, y } = subgroupLabel(group);
                  return (
                    <text
                      key={group.id}
                      x={x}
                      y={y}
                      dy="0.35em"
                      fontSize={font}
                      textAnchor="middle"
                      className="radar-subring-label"
                      data-day={group.day}
                    >
                      {group.label}
                    </text>
                  );
                })}
                {rim.map(({ stamp, titles, tick, end, point }) => (
                  <g
                    key={stamp}
                    className="radar-rim-marker"
                    aria-label={`${stamp}, ${titles.join(", ")}`}
                    role="img"
                  >
                    <title>{titles.join(", ")}</title>
                    <line x1={tick.x} y1={tick.y} x2={end.x} y2={end.y} />
                    <text
                      x={point.x}
                      y={point.y}
                      dy="0.35em"
                      textAnchor="middle"
                      fontSize={font}
                    >
                      {stamp}
                    </text>
                  </g>
                ))}
                {shownBands.map((band) => {
                  const { point, text } = ringLabel(
                    band,
                    edges,
                    band === split,
                  );
                  return (
                    <text
                      key={band}
                      x={point.x}
                      y={point.y}
                      dy="0.35em"
                      fontSize={font}
                      className="radar-band-label"
                      textAnchor="middle"
                      role="button"
                      tabIndex={visibleBands.includes(band) ? 0 : undefined}
                      aria-hidden={!visibleBands.includes(band) || undefined}
                      aria-label={RADAR_LABELS[band]}
                      aria-expanded={band === split}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleBand(band);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleBand(band);
                        }
                      }}
                    >
                      {text}
                    </text>
                  );
                })}
              </>
            )}
          </g>
        </svg>
        {finishSubject && (
          <div
            className="radar-finish"
            data-goal={Boolean(goal)}
            data-resting={!showFinish}
          >
            {FINISH_TARGETS.map(({ status, glyph, label }) => (
              <button
                key={status}
                type="button"
                className="radar-finish-target"
                data-drop-finish={status}
                data-target={finishing === status}
                aria-label={`Mark ${finishSubject.title} ${status === "done" ? "done" : "won't do"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  // A drop finishes on release; this is the tap.
                  if (!preview) finishItem(finishSubject, status);
                }}
              >
                <span className="radar-finish-glyph" aria-hidden="true">
                  {glyph}
                </span>
                {label}
              </button>
            ))}
          </div>
        )}
        {finishing && bubbleById.get(preview!.id) && (
          // Keeps the finishing bubble visible above the finish targets.
          <div className="radar-drag-layer" aria-hidden="true" inert>
            <svg
              className="radar-svg"
              viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
            >
              <g transform={dragTransform}>
                <RadarBubble
                  bubble={bubbleById.get(preview!.id)!}
                  project={identities.get(
                    bubbleById.get(preview!.id)!.item.project_id,
                  )}
                  shape={itemShape(
                    readTags(bubbleById.get(preview!.id)!.item.tags),
                    tagShapes,
                  )}
                  selected={false}
                  live={false}
                  now={now}
                  labelScale={labelScale}
                  timeFormatter={timeFormatter}
                  onActivate={ignore}
                  onGesture={ignore}
                  onPriority={ignore}
                  onTooltip={ignore}
                  finishing={finishing}
                />
              </g>
            </svg>
          </div>
        )}
        <div aria-live="polite">
          {dropMessage && (
            <p
              className="radar-tooltip"
              data-actionable={Boolean(dropMessage.undo && undoFinish)}
            >
              {dropMessage.text}
              {dropMessage.undo && undoFinish && (
                <button
                  type="button"
                  className="subtle radar-undo"
                  onClick={() => {
                    undoFinish(dropMessage.undo!);
                    setDropMessage(null);
                  }}
                >
                  Undo
                </button>
              )}
            </p>
          )}
        </div>
        <div className="sr-only" aria-live="polite">
          {split
            ? `${RADAR_LABELS[split]} split${subrings.length ? `: ${subrings.map(({ label }) => label).join(", ")}` : ""}.`
            : "Whole radar."}
        </div>
        {!dropMessage && tooltip && !preview && (
          <p className="radar-tooltip">{tooltip}</p>
        )}
      </div>
    </div>
  );
}
