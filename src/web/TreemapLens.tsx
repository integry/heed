import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { rollUpRing } from "../shared/derived-state";
import type { LensProps } from "./lenses";
import {
  buildTreemap,
  layoutTreemap,
  resolveTreemapFocus,
  treemapHeaderHeight,
  type TreemapRect,
} from "./treemap-layout";
import { itemRing, ringLabels } from "./workspace-view";
import "./treemap.css";

type TileControls = Pick<
  LensProps,
  "items" | "dependencies" | "now" | "selectedId" | "select"
> & {
  allItems: ReadonlyArray<LensProps["tree"][number]["item"]>;
  zoom: (key: string) => void;
  tap: (event: MouseEvent, key: string | null) => void;
};

function Tile({
  rect,
  controls,
}: {
  rect: TreemapRect;
  controls: TileControls;
}) {
  const { data, parent, children } = rect;
  const { items, allItems, dependencies, now, selectedId, select, zoom, tap } =
    controls;
  const item = data.kind === "item" ? data.item : null;
  const ghost = item?.status === "done";
  const { done, total } = item?.progress ?? { done: 0, total: 0 };
  const ring = item && itemRing(item, now, items, dependencies);
  const rollup =
    item && total > 0 ? rollUpRing(item, allItems, dependencies, now) : null;
  const detail = [
    ghost ? "Completed" : ring && ringLabels[ring],
    rollup && `Descendants · ${ringLabels[rollup]}`,
    total > 0 && `${done} of ${total} complete`,
  ]
    .filter(Boolean)
    .join(" · ");
  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  if (width <= 0 || height <= 0) return null;
  const labelHeight = children
    ? treemapHeaderHeight(data.kind, height)
    : height;
  const hasZoomButton = children && width >= 52 && labelHeight >= 24;
  const style = {
    left: rect.x0 - parent!.x0,
    top: rect.y0 - parent!.y0,
    width,
    height,
    "--tile-label-height": `${labelHeight}px`,
    "--tile-lines": Math.max(1, Math.floor((labelHeight - 6) / 16)),
    ...(data.kind === "project" && data.project.color
      ? { "--tile-project": data.project.color }
      : {}),
  } as CSSProperties;

  return (
    <div
      className="treemap-tile"
      data-kind={data.kind}
      data-parent={Boolean(children)}
      data-ring={ring ?? undefined}
      data-ghost={ghost}
      style={style}
    >
      <button
        type="button"
        className="treemap-tile-button"
        aria-label={data.title}
        aria-description={detail || undefined}
        aria-pressed={item ? selectedId === item.id : undefined}
        title={[data.title, detail].filter(Boolean).join(" · ")}
        onClick={(event) => {
          if (item) select(item.id);
          if (!item && event.detail === 0) zoom(data.key);
          else tap(event, children ? data.key : null);
        }}
        onDoubleClick={children ? () => zoom(data.key) : undefined}
        onKeyDown={(event) => {
          if (children && event.key === "ArrowRight") {
            event.preventDefault();
            zoom(data.key);
          }
        }}
      >
        {width >= 24 && labelHeight >= 16 && (
          <span className="treemap-title" data-zoom={Boolean(hasZoomButton)}>
            {data.title}
          </span>
        )}
      </button>
      {children?.map((child) => (
        <Tile key={child.data.key} rect={child} controls={controls} />
      ))}
      {hasZoomButton && (
        <button
          className="treemap-zoom"
          type="button"
          aria-label={`Zoom into ${data.title}`}
          onClick={() => zoom(data.key)}
        >
          <span aria-hidden="true">›</span>
        </button>
      )}
      {rollup && (
        <span
          className="treemap-rollup"
          data-ring={rollup}
          aria-hidden="true"
        />
      )}
      {total > 0 && (
        <span className="treemap-progress" aria-hidden="true">
          <span style={{ width: `${(done / total) * 100}%` }} />
        </span>
      )}
    </div>
  );
}

export function TreemapLens({
  tree,
  projects,
  showGhosts,
  items,
  dependencies,
  now,
  selectedId,
  select,
}: LensProps) {
  const chart = useRef<HTMLDivElement>(null);
  const breadcrumb = useRef<HTMLSpanElement>(null);
  const focusBreadcrumb = useRef(false);
  const lastTap = useRef<{ key: string; time: number } | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [{ width, height }, setSize] = useState({ width: 800, height: 560 });
  const root = useMemo(
    () => buildTreemap(projects, tree, showGhosts),
    [projects, tree, showGhosts],
  );
  const focused = resolveTreemapFocus(root, path, selectedId);
  const trail = focused.ancestors().reverse();
  if (focused.depth < path.length)
    setPath(trail.slice(1).map(({ data }) => data.key));
  const layout = useMemo(
    () => layoutTreemap(focused, width, height),
    [focused, width, height],
  );
  const allItems = useMemo(() => [...items.values()], [items]);

  useLayoutEffect(() => {
    if (!chart.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(chart.current);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!focusBreadcrumb.current) return;
    focusBreadcrumb.current = false;
    breadcrumb.current?.focus();
  }, [focused.data.key]);

  function navigate(next: string[]) {
    focusBreadcrumb.current = true;
    lastTap.current = null;
    setPath(next);
  }

  function zoom(key: string) {
    const target = root.find(({ data }) => data.key === key);
    if (!target?.children) return;
    if (target.data.kind === "item") {
      if (selectedId !== target.data.item.id) select(target.data.item.id);
    } else if (
      selectedId &&
      !target.find(({ data }) => data.key === `item:${selectedId}`)
    ) {
      select(null);
    }
    navigate(
      target
        .ancestors()
        .reverse()
        .slice(1)
        .map(({ data }) => data.key),
    );
  }

  function tap(event: MouseEvent, key: string | null) {
    if (
      !key ||
      !("pointerType" in event.nativeEvent) ||
      event.nativeEvent.pointerType !== "touch"
    ) {
      lastTap.current = null;
      return;
    }
    const previous = lastTap.current;
    const time = event.timeStamp;
    if (previous?.key === key && time - previous.time <= 350) zoom(key);
    else lastTap.current = { key, time };
  }

  const controls = {
    items,
    allItems,
    dependencies,
    now,
    selectedId,
    select,
    zoom,
    tap,
  };
  const project = trail[1]?.data;

  return (
    <div className="treemap">
      <nav className="treemap-breadcrumb" aria-label="Treemap breadcrumb">
        {trail.map(({ data }, index) =>
          index === trail.length - 1 ? (
            <span
              key={data.key}
              ref={breadcrumb}
              aria-current="location"
              tabIndex={-1}
            >
              {data.title}
            </span>
          ) : (
            <button
              key={data.key}
              type="button"
              className="subtle"
              onClick={() => navigate(path.slice(0, index))}
            >
              {data.title}
            </button>
          ),
        )}
      </nav>
      <div
        className="treemap-chart"
        ref={chart}
        hidden={!layout.children}
        style={
          project?.kind === "project" && project.project.color
            ? ({ "--tile-project": project.project.color } as CSSProperties)
            : undefined
        }
      >
        {layout.children?.map((rect) => (
          <Tile key={rect.data.key} rect={rect} controls={controls} />
        ))}
      </div>
      {!layout.children && <p className="empty">No items in this view.</p>}
    </div>
  );
}
