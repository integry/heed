import { DemoBadge } from "./item-markers";
import { GuideEmpty } from "./Onboarding";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { isLive } from "@heedwork/core";
import type { Dependency } from "@heedwork/core";
import {
  blockerCounts,
  CARD_HEIGHT,
  CARD_WIDTH,
  dependencyPath,
  layoutDependencies,
  scopeDependencies,
} from "./dependency-graph";
import type { LensProps } from "./lenses";
import { itemStatus } from "./workspace-view";
import "./dependencies.css";

type Point = { x: number; y: number };

export function DependenciesLens(props: LensProps) {
  return <DependencyGraph key={props.goalId} {...props} />;
}

function DependencyGraph({
  goalId,
  items,
  filtered,
  dependencies,
  selectedId,
  select,
  focusGoal,
  now,
  live,
  showGhosts,
  changeDependency,
  savingDependency,
  openGuide,
}: LensProps) {
  const arrow = useId();
  const chart = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    id: string;
    pointer: number;
    start: Point;
    moved: boolean;
  }>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<Point>();
  const [source, setSource] = useState<string>();
  const [chosenEdge, setChosenEdge] = useState<Dependency>();
  const cancelConnection = useCallback(() => {
    if (gesture.current) suppressClick.current = true;
    gesture.current = null;
    setPreview(undefined);
    setSource(undefined);
  }, []);

  useEffect(() => {
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && gesture.current) cancelConnection();
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [cancelConnection]);
  const goal = goalId ? filtered.get(goalId) : undefined;
  const graph = useMemo(() => {
    if (!goalId) return;
    const visible = showGhosts
      ? filtered
      : new Map([...filtered].filter(([, item]) => item.status !== "done"));
    const scope = scopeDependencies(goalId, items, visible, dependencies);
    const counts = blockerCounts(scope.nodes, scope.edges);
    return {
      ...scope,
      ...layoutDependencies(scope.nodes, scope.edges),
      counts,
      maxCount: Math.max(0, ...counts.values()),
    };
  }, [goalId, items, filtered, dependencies, showGhosts]);

  if (!goal || !graph) {
    const goals = [...filtered.values()]
      .filter(({ parent_id }) => parent_id === null)
      .sort((a, b) => a.title.localeCompare(b.title));
    if (!goals.length)
      return (
        <GuideEmpty openGuide={openGuide}>No goals in this view.</GuideEmpty>
      );
    return (
      <div className="dependency-picker">
        <p>Pick a goal to see its dependencies.</p>
        <label className="form-field">
          Goal
          <select
            value=""
            onChange={(event) => {
              if (!event.target.value) return;
              focusGoal(event.target.value);
              select(event.target.value);
            }}
          >
            <option value="">Choose a goal</option>
            {goals.map(({ id, title }) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  const { nodes, descendants, edges } = graph;
  const activeSource =
    live && source && graph.nodes.has(source) ? source : null;
  const origin = activeSource ? graph.positions.get(activeSource) : undefined;
  const selectedEdge = graph.edges.find(
    (edge) =>
      edge.item_id === chosenEdge?.item_id &&
      edge.blocked_by_id === chosenEdge.blocked_by_id,
  );
  const canEdit = live && !savingDependency;
  const title = (id: string) => items.get(id)!.title;
  const edgeLabel = ({ item_id, blocked_by_id }: Dependency) =>
    `${title(blocked_by_id)} blocks ${title(item_id)}`;

  function canConnect(blocker: string, blocked: string) {
    return (
      nodes.has(blocker) &&
      nodes.has(blocked) &&
      blocker !== blocked &&
      (descendants.has(blocker) || descendants.has(blocked)) &&
      !edges.some(
        (edge) => edge.item_id === blocked && edge.blocked_by_id === blocker,
      )
    );
  }

  function activateNode(id: string) {
    setChosenEdge(undefined);
    if (activeSource && canConnect(activeSource, id))
      changeDependency({ item_id: id, blocked_by_id: activeSource }, "add");
    else select(id);
    setSource(undefined);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (!canEdit || event.button !== 0 || gesture.current) return;
    suppressClick.current = false;
    gesture.current = {
      id,
      pointer: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function dragPoint(event: PointerEvent) {
    const drag = gesture.current;
    if (
      !drag ||
      drag.pointer !== event.pointerId ||
      (!drag.moved &&
        Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) <
          5)
    )
      return;
    drag.moved = true;
    return drag;
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragPoint(event);
    if (!drag || !chart.current) return;
    const bounds = chart.current.getBoundingClientRect();
    setSource(drag.id);
    setChosenEdge(undefined);
    setPreview({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (gesture.current?.pointer !== event.pointerId) return;
    const drag = dragPoint(event);
    gesture.current = null;
    setPreview(undefined);
    if (!drag) return;
    suppressClick.current = true;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-dependency-node]");
    const blocked = target?.dataset.dependencyNode;
    if (
      blocked &&
      chart.current?.contains(target) &&
      canConnect(drag.id, blocked)
    )
      changeDependency({ item_id: blocked, blocked_by_id: drag.id }, "add");
    setSource(undefined);
  }

  function cancelDrag(event: PointerEvent) {
    if (gesture.current?.pointer !== event.pointerId) return;
    cancelConnection();
  }

  return (
    <div
      className="dependency-lens"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        cancelConnection();
        setChosenEdge(undefined);
      }}
    >
      <div className="dependency-toolbar">
        <h2>{goal.title}</h2>
        <button
          type="button"
          className="subtle"
          onClick={() => focusGoal(null)}
        >
          Change goal
        </button>
      </div>
      {graph.nodes.size ? (
        <>
          <p className="dependency-help" aria-live="polite">
            {activeSource && !preview
              ? `Choose an item blocked by ${title(activeSource)}.`
              : "Drag a node’s arrow to the item it blocks, or select the arrow and then the item."}
          </p>
          <div
            className="dependency-viewport"
            role="region"
            aria-label={`Dependency graph for ${goal.title}`}
            tabIndex={0}
          >
            <div
              className="dependency-chart"
              ref={chart}
              style={{ width: graph.width, height: graph.height }}
            >
              <svg
                className="dependency-edges"
                width={graph.width}
                height={graph.height}
              >
                <defs>
                  <marker
                    id={arrow}
                    markerWidth="8"
                    markerHeight="8"
                    viewBox="0 0 8 8"
                    refX="8"
                    refY="4"
                    orient="auto"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 Z" fill="context-stroke" />
                  </marker>
                </defs>
                {graph.routes.map(({ edge, waypoints }) => {
                  const start = waypoints[0];
                  const end = waypoints[waypoints.length - 1];
                  const d = dependencyPath([
                    { x: start.x + CARD_WIDTH, y: start.y },
                    ...waypoints.slice(1, -1).flatMap(({ x, y }) => [
                      { x, y },
                      { x: x + CARD_WIDTH, y },
                    ]),
                    end,
                  ]);
                  const choose = () => {
                    setSource(undefined);
                    setChosenEdge(edge);
                  };
                  return (
                    <g
                      key={JSON.stringify([edge.item_id, edge.blocked_by_id])}
                      role="button"
                      tabIndex={0}
                      aria-label={edgeLabel(edge)}
                      aria-pressed={edge === selectedEdge}
                      className="dependency-edge"
                      data-done={
                        items.get(edge.blocked_by_id)?.status === "done"
                      }
                      onClick={choose}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        choose();
                      }}
                    >
                      <path className="dependency-edge-hit" d={d} />
                      <path
                        className="dependency-edge-line"
                        d={d}
                        markerEnd={`url(#${arrow})`}
                      />
                    </g>
                  );
                })}
                {preview && origin && (
                  <path
                    className="dependency-preview"
                    d={dependencyPath([
                      { x: origin.x + CARD_WIDTH, y: origin.y },
                      preview,
                    ])}
                    markerEnd={`url(#${arrow})`}
                    aria-hidden="true"
                  />
                )}
              </svg>
              {[...graph.positions].map(([id, point]) => {
                const item = graph.nodes.get(id)!;
                const count = graph.counts.get(id) ?? 0;
                const keyBlocker = count > 0 && count === graph.maxCount;
                const external = id !== goalId && !graph.descendants.has(id);
                const status = itemStatus(item, now, items, dependencies);
                return (
                  <div
                    key={id}
                    className="dependency-node"
                    data-dependency-node={id}
                    data-external={external}
                    data-blocker={keyBlocker}
                    data-done={item.status === "done"}
                    data-target={Boolean(
                      activeSource && canConnect(activeSource, id),
                    )}
                    data-connecting={activeSource === id}
                    style={{
                      left: point.x,
                      top: point.y - CARD_HEIGHT / 2,
                      width: CARD_WIDTH,
                      height: CARD_HEIGHT,
                    }}
                  >
                    <button
                      className="dependency-card"
                      type="button"
                      aria-pressed={selectedId === id}
                      onClick={() => activateNode(id)}
                    >
                      <span className="dependency-title" title={item.title}>
                        {item.title}
                      </span>
                      {item.demo === 1 && <DemoBadge />}
                      <span className="dependency-meta">
                        <span className="item-status" data-status={status}>
                          {status}
                        </span>
                        {item.agent_name && (
                          <span
                            className="dependency-agent"
                            title={item.agent_name}
                          >
                            {status !== "Live" && isLive(item, now) && (
                              <span
                                className="dependency-live"
                                aria-label="Live"
                              />
                            )}
                            {item.agent_name}
                          </span>
                        )}
                      </span>
                      {(external || keyBlocker) && (
                        <span className="dependency-labels">
                          {external && <span>External</span>}
                          {keyBlocker && (
                            <strong>
                              Blocks {count} {count === 1 ? "item" : "items"}
                            </strong>
                          )}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="dependency-handle"
                      aria-label={`Connect ${item.title} as a blocker`}
                      aria-pressed={activeSource === id}
                      disabled={!canEdit}
                      onPointerDown={(event) => startDrag(event, id)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={cancelDrag}
                      onLostPointerCapture={cancelDrag}
                      onClick={(event) => {
                        // Pointer capture also delivers a click after a drag.
                        if (event.detail !== 0 && suppressClick.current) return;
                        setChosenEdge(undefined);
                        setSource(activeSource === id ? undefined : id);
                      }}
                    >
                      <span aria-hidden="true">→</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          {selectedEdge && (
            <div className="dependency-actions">
              <span>{edgeLabel(selectedEdge)}</span>
              <button
                type="button"
                className="subtle"
                disabled={!canEdit}
                onClick={() => changeDependency(selectedEdge, "remove")}
              >
                Remove dependency
              </button>
            </div>
          )}
        </>
      ) : (
        <GuideEmpty openGuide={openGuide}>
          No items in this goal’s current view.
        </GuideEmpty>
      )}
    </div>
  );
}
