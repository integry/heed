import { select as d3Select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  effectiveSchedule,
  isBlocked,
  isLive,
  isStale,
  radarBandsFor,
  rollUpRing,
  type Ring,
  type StreamRow,
} from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import type { Project, RadarBand } from "../shared/workspace";
import type { LensProps } from "./lenses";
import { RadarBubble, type Bubble } from "./RadarBubble";
import {
  bubbleRadius,
  cellBounds,
  cellPoint,
  CENTER,
  GOAL_RADIUS,
  goalPoint,
  goalPosition,
  HEIGHT,
  layoutGoal,
  layoutRadar,
  polar,
  priorityForRadius,
  RADAR_BANDS,
  RADAR_LABELS,
  RADAR_RADIUS,
  radarDrop,
  readRadarPosition,
  scheduleForRing,
  seedPosition,
  targetCell,
  truncateLabel,
  WIDTH,
  type Cell,
  type Point,
} from "./radar-geometry";
import "./radar.css";

const colors = [
  "#4c8274",
  "#6f75b6",
  "#a56546",
  "#8b6b9f",
  "#6d8547",
  "#9b6676",
];
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const translate = ({ x, y }: Point) => `translate(${x},${y})`;

type Gesture = {
  id: string;
  pointer: number;
  kind: "move" | "resize";
  start: Point;
  origin: Point;
  client: Point;
  radius: number;
  moved: boolean;
};
type Preview = { id: string; point: Point; priority?: number };

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

function goalDropTarget(point: Point) {
  if (point.y < 692 || point.y > 740) return undefined;
  return RADAR_BANDS.find(
    (_, index) => Math.abs(point.x - (175 + index * 150)) <= 67,
  );
}

function RadarField({
  projects,
  highlight,
}: {
  projects: readonly Project[];
  highlight: Cell | null;
}) {
  const sectors = projects.length || 1;
  return (
    <g aria-hidden="true" className="radar-field">
      {[...RADAR_BANDS].reverse().map((band) => {
        const { outer } = cellBounds({ band, sector: 0, sectors });
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
      {projects.map((project, sector) => {
        const { start, span } = cellBounds({
          band: "backlog",
          sector,
          sectors,
        });
        const edge = polar(start, RADAR_RADIUS);
        const label = polar(start + span / 2, RADAR_RADIUS + 24);
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
            <text
              x={label.x}
              y={label.y}
              dy="0.35em"
              textAnchor="middle"
              className="radar-project-label"
            >
              {truncateLabel(project.name, Math.min(155, 225 * span), 14)}
              <title>{project.name}</title>
            </text>
          </g>
        );
      })}
      {highlight && (
        <path d={pathForCell(highlight)} className="radar-drop-cell" />
      )}
      {RADAR_BANDS.map((band) => {
        const { inner } = cellBounds({ band, sector: 0, sectors });
        return (
          <text
            key={band}
            x={CENTER.x}
            y={CENTER.y - inner - (inner ? 8 : 0)}
            className="radar-band-label"
            textAnchor="middle"
          >
            {band === "today" ? "Today · You" : RADAR_LABELS[band]}
          </text>
        );
      })}
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
  focusGoal,
  openDependencies,
  moveRadar,
  reschedule,
  setPriority,
}: LensProps) {
  const svg = useRef<SVGSVGElement>(null);
  const layer = useRef<SVGGElement>(null);
  const behavior = useRef<ZoomBehavior<SVGSVGElement, unknown>>(null);
  const gesture = useRef<Gesture | null>(null);
  const preventClick = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tooltip, setTooltip] = useState<string | null>(null);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
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
  const entries = goal?.children ?? roots;
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
    () => JSON.stringify([layoutKey, projectIds, setup.map(({ id }) => id)]),
    [layoutKey, projectIds, setup],
  );
  const [layout, setLayout] = useState(() => ({
    signature,
    radar: goal ? undefined : layoutRadar(setup),
    packed: goal ? layoutGoal(setup) : undefined,
  }));
  if (layout.signature !== signature) {
    // A status or schedule change can move its own bubble to a new cell.
    // Preserve all automatic offsets until the set of nodes or sectors changes.
    setLayout({
      signature,
      radar: goal ? undefined : layoutRadar(setup),
      packed: goal ? layoutGoal(setup) : undefined,
    });
  }

  const allItems = useMemo(() => [...items.values()], [items]);
  const bubbles = useMemo(
    () =>
      setup.map(({ item, cell, position }) => {
        const packed = layout.packed?.get(item.id);
        const plotted = layout.radar?.get(item.id);
        const scale = packed?.scale ?? plotted?.scale ?? 1;
        const radius = bubbleRadius(item.priority) * scale;
        const point = goal
          ? position
            ? goalPoint(position, radius)
            : (packed?.point ?? CENTER)
          : cellPoint(
              cell,
              position ?? plotted?.position ?? seedPosition(item.id),
            );

        let ring: Ring | null = null;
        if (item.status !== "done") {
          if (item.handoff) ring = "handoff";
          else if (isStale(item, now)) ring = "stale";
          else if (item.reopen_count) ring = "reopened";
          else if (isBlocked(item, items, dependencies)) ring = "blocked";
          else if (isLive(item, now)) ring = "live";
        }
        const rollup =
          item.progress.total > 0
            ? rollUpRing(item, allItems, dependencies, now)
            : null;
        return {
          item,
          point,
          radius,
          scale,
          ring,
          rollup,
          color:
            projects[cell.sector].color ?? colors[cell.sector % colors.length],
          opensGoal: Boolean(rows.get(item.id)?.children.length),
        } satisfies Bubble;
      }),
    [setup, layout, goal, now, items, dependencies, projects, rows, allItems],
  );
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

  useEffect(() => {
    const element = svg.current!;
    const scene = layer.current!;
    const canvas = d3Select(element);
    const control = zoom<SVGSVGElement, unknown>()
      .extent([
        [0, 0],
        [WIDTH, HEIGHT],
      ])
      .translateExtent([
        [-WIDTH / 2, -HEIGHT / 2],
        [WIDTH * 1.5, HEIGHT * 1.5],
      ])
      .scaleExtent([0.65, 6])
      .filter((event: MouseEvent | TouchEvent) => {
        if (event.type === "touchstart") return true;
        if (event.type === "wheel") return true;
        const target = event.target as Element;
        return (
          !(event as MouseEvent).button &&
          !event.ctrlKey &&
          !target.closest("[data-radar-bubble], [data-radar-resize]")
        );
      })
      .on("zoom", ({ transform }) => {
        scene.setAttribute("transform", String(transform));
        element.classList.toggle("radar-magnified", transform.k >= 1.8);
      });
    behavior.current = control;
    canvas.call(control);

    function singleFingerDrag(event: TouchEvent) {
      // Let d3 see both touch starts and all pinch moves. During a one-finger
      // bubble drag, only the pointer gesture should move the chart's contents.
      if (!gesture.current || event.touches.length !== 1) return;
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
    };
  }, []);

  useEffect(() => {
    if (behavior.current)
      d3Select(svg.current!).call(behavior.current.transform, zoomIdentity);
  }, [goal?.item.id]);

  function zoomBy(factor: number) {
    if (behavior.current)
      d3Select(svg.current!).call(behavior.current.scaleBy, factor);
  }

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
      if (event.button !== 0 || !event.isPrimary) return;
      setDropMessage(null);
      const point = scenePoint(event);
      gesture.current = {
        id: bubble.item.id,
        pointer: event.pointerId,
        kind,
        start: point,
        origin: bubble.point,
        client: { x: event.clientX, y: event.clientY },
        radius: bubble.radius,
        moved: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [],
  );

  const cancelGesture = useCallback(() => {
    if (gesture.current?.moved) preventClick.current = true;
    gesture.current = null;
    setPreview(null);
  }, []);

  function dragPreview(event: PointerEvent<SVGSVGElement>) {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    const bubble = bubbles.find(({ item }) => item.id === active.id);
    if (!bubble) return;
    if (
      !active.moved &&
      distance(active.client, { x: event.clientX, y: event.clientY }) < 4
    )
      return;
    active.moved = true;
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
    setDropMessage(
      `${item.title} can’t move to ${RADAR_LABELS[target]} because ${reason}.`,
    );
    return false;
  }

  function release(event: PointerEvent<SVGSVGElement>) {
    if (gesture.current?.pointer !== event.pointerId) return;
    const drag = dragPreview(event);
    cancelGesture();
    if (!drag || !live) return;
    const { next, bubble } = drag;
    const { item } = bubble;
    const dropTime = Math.max(now, Date.now());
    if (next.priority !== undefined) {
      if (item.priority !== next.priority) setPriority(item.id, next.priority);
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
      }
    } else {
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

  const onActivate = useCallback(
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
  let highlight: Cell | null = null;
  if (!goal && moving) {
    const cell = targetCell(preview.point, projects.length);
    const item = bubbleById.get(preview.id)?.item;
    if (
      cell &&
      item &&
      (item.parent_id === null || item.project_id === projectIds[cell.sector])
    )
      highlight = cell;
  }

  return (
    <div className="radar">
      <div className="radar-toolbar">
        {goal && (
          <nav className="radar-breadcrumb" aria-label="Goal breadcrumb">
            <button
              className="subtle"
              type="button"
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
                  onClick={() => goBack(item.id)}
                >
                  {item.title}
                </button>
              ),
            )}
          </nav>
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
              if (behavior.current)
                d3Select(svg.current!).call(
                  behavior.current.transform,
                  zoomIdentity,
                );
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
      {!entries.length && <p className="empty">No items in this view.</p>}
      <div className="radar-chart" data-dragging={Boolean(preview)}>
        <svg
          ref={svg}
          className="radar-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          aria-label={
            goal
              ? `Items in ${goal.item.title}`
              : "Items by time ring and project"
          }
          onPointerDownCapture={(event) => {
            preventClick.current = false;
            if (event.pointerType === "touch" && !event.isPrimary)
              cancelGesture();
          }}
          onPointerMove={(event) => {
            const result = dragPreview(event);
            if (result) setPreview(result.next);
          }}
          onPointerUp={release}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={(event) => {
            if (gesture.current?.pointer === event.pointerId) cancelGesture();
          }}
          onClickCapture={(event) => {
            if (preventClick.current && event.detail !== 0) {
              preventClick.current = false;
              event.stopPropagation();
            }
          }}
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
                      transform={translate({ x: 175 + index * 150, y: 716 })}
                      className="radar-goal-drop"
                      data-target={goalDropTarget(preview.point) === band}
                    >
                      <rect x={-67} y={-24} width={134} height={48} rx={9} />
                      <text textAnchor="middle" dy="0.35em">
                        {RADAR_LABELS[band]}
                      </text>
                    </g>
                  ))}
              </g>
            ) : (
              <RadarField projects={projects} highlight={highlight} />
            )}
            {displayed.map((bubble) => (
              <RadarBubble
                key={bubble.item.id}
                bubble={bubble}
                selected={selectedId === bubble.item.id}
                live={live}
                now={now}
                timeFormatter={timeFormatter}
                onActivate={onActivate}
                onGesture={onGesture}
                onPriority={setPriority}
                onTooltip={setTooltip}
              />
            ))}
          </g>
        </svg>
        <div aria-live="polite">
          {dropMessage && <p className="radar-tooltip">{dropMessage}</p>}
        </div>
        {!dropMessage && tooltip && !preview && (
          <p className="radar-tooltip">{tooltip}</p>
        )}
      </div>
    </div>
  );
}
