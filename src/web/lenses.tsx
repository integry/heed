import type { ComponentType } from "react";
import type { StreamRow } from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import type { Dependency, Project } from "../shared/workspace";
import { itemStatus } from "./workspace-view";
import { BoardLens } from "./BoardLens";
import type { StreamMove } from "./stream-move";
import { RadarLens } from "./RadarLens";
import type { RadarPlacement } from "./radar-geometry";

export interface LensProps {
  tree: readonly StreamRow<CanvasItem>[];
  projects: readonly Project[];
  items: ReadonlyMap<string, CanvasItem>;
  dependencies: readonly Dependency[];
  selectedId: string | null;
  now: number;
  timezone: string;
  live: boolean;
  showGhosts: boolean;
  goalId: string | null;
  focusGoal: (id: string | null) => void;
  openDependencies?: () => void;
  select: (id: string | null) => void;
  move: (mutation: StreamMove) => boolean;
  reschedule: (id: string, date: string | null) => void;
  moveProject: (id: string, projectId: string) => void;
  setPriority: (id: string, priority: number) => void;
  setPosition: (id: string, position: Record<string, number>) => void;
  moveRadar: (id: string, drop: RadarPlacement, layoutKey?: string) => void;
}

export interface Lens {
  id: string;
  label: string;
  component: ComponentType<LensProps>;
}

function ListRows({
  tree,
  ...rowProps
}: Pick<
  LensProps,
  "tree" | "items" | "dependencies" | "selectedId" | "now" | "select"
>) {
  const { items, dependencies, selectedId, now, select } = rowProps;
  return (
    <ul className="item-list">
      {tree.map(({ item, children }) => {
        const status = itemStatus(item, now, items, dependencies);
        return (
          <li key={item.id}>
            <button
              type="button"
              className="item-row"
              aria-pressed={selectedId === item.id}
              onClick={() => select(item.id)}
            >
              <span className="item-title">{item.title}</span>
              <span className="item-status" data-status={status}>
                {status}
              </span>
            </button>
            {children.length > 0 && <ListRows tree={children} {...rowProps} />}
          </li>
        );
      })}
    </ul>
  );
}

function ListLens({
  tree,
  projects,
  items,
  dependencies,
  selectedId,
  now,
  select,
}: LensProps) {
  if (!tree.length) return <p className="empty">No items in this view.</p>;
  return projects.map(({ id, name }) => {
    const rows = tree.filter(({ item }) => item.project_id === id);
    if (!rows.length) return null;
    return (
      <section className="project-group" key={id}>
        <h3>{name}</h3>
        <ListRows
          tree={rows}
          items={items}
          dependencies={dependencies}
          selectedId={selectedId}
          now={now}
          select={select}
        />
      </section>
    );
  });
}

export const lensRegistry: readonly [Lens, ...Lens[]] = [
  { id: "radar", label: "Radar", component: RadarLens },
  { id: "board", label: "Board", component: BoardLens },
  { id: "list", label: "List", component: ListLens },
];

const storageKey = "heed.lens";

export function resolveLens(
  registry: readonly [Lens, ...Lens[]],
  id: string | null,
) {
  return registry.find((lens) => lens.id === id) ?? registry[0];
}

export function readLensId() {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function rememberLens(id: string) {
  try {
    localStorage.setItem(storageKey, id);
  } catch {
    // The current tab can still switch lenses with storage disabled.
  }
}
