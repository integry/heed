import { GuideEmpty } from "./Onboarding";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { radarBandsFor } from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import type { RadarBand } from "@heedwork/core";
import { boardMove, type BoardSlot } from "./board-move";
import {
  DemoBadge,
  ItemMarkers,
  ItemTimeBadge,
  itemTimeFormats,
} from "./item-markers";
import type { LensProps } from "./lenses";
import { RADAR_BANDS, RADAR_LABELS } from "./radar-geometry";
import { hasFixedOrder } from "./stream-move";
import { useItemDrag } from "./use-item-drag";
import "./board.css";

function boardDropSlot(
  x: number,
  y: number,
  pane: HTMLElement,
): BoardSlot | null {
  const hit = document.elementFromPoint(x, y);
  const cell = hit?.closest<HTMLElement>("[data-board-band]");
  if (!cell || !pane.contains(cell)) return null;
  const card = hit?.closest<HTMLElement>("[data-board-card]");
  const rect = card?.getBoundingClientRect();
  return {
    band: cell.dataset.boardBand as RadarBand,
    project: cell.dataset.boardProject!,
    anchor: card?.dataset.boardCard ?? null,
    side: rect && y < rect.top + rect.height / 2 ? "before" : "after",
  };
}

export function BoardLens({
  tree,
  projects,
  items,
  dependencies,
  selectedId,
  now,
  timezone,
  live,
  showGhosts,
  select,
  move,
  openGuide,
}: LensProps) {
  const [message, setMessage] = useState<{
    text: string;
    problem?: boolean;
  } | null>(null);
  const [keyboardMove, setKeyboardMove] = useState<{ id: string } | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const formats = useMemo(() => itemTimeFormats(timezone), [timezone]);
  const visibleProjects = projects.filter(({ hidden }) => !hidden);
  const { placements, cells } = useMemo(() => {
    const roots = tree
      .map(({ item }) => item)
      .filter(
        (item) =>
          item.parent_id === null && (showGhosts || item.status !== "done"),
      );
    const placements = radarBandsFor(roots, items, now, timezone);
    const cells = new Map<string, Map<RadarBand, CanvasItem[]>>();
    // The workspace tree already applies the stream comparator.
    for (const item of roots) {
      const band = placements.get(item.id)!;
      const project =
        cells.get(item.project_id) ?? new Map<RadarBand, CanvasItem[]>();
      const cards = project.get(band) ?? [];
      cards.push(item);
      project.set(band, cards);
      cells.set(item.project_id, project);
    }
    return { placements, cells };
  }, [tree, items, now, timezone, showGhosts]);

  useLayoutEffect(() => {
    if (keyboardMove) handles.current.get(keyboardMove.id)?.focus();
  }, [keyboardMove]);

  function commit(id: string, slot: BoardSlot | null) {
    const item = items.get(id);
    const band = placements.get(id);
    if (!live || !slot || !item || !band) return;
    const source = { project: item.project_id, band };
    const sameCell = band === slot.band && source.project === slot.project;
    const peers =
      cells
        .get(source.project)
        ?.get(band)
        ?.filter((card) => card.status !== "done") ?? [];
    if (
      sameCell &&
      slot.anchor &&
      !peers.some((card) => card.id === slot.anchor)
    )
      return;

    const mutation = boardMove(item, source, slot, peers, items, now, timezone);
    const target = `${visibleProjects.find(({ id }) => id === slot.project)?.name} · ${RADAR_LABELS[slot.band]}`;
    if (mutation && move(mutation)) {
      setMessage({
        text: sameCell
          ? `Reordered ${item.title} in ${target}.`
          : `Moved ${item.title} to ${target}.`,
      });
      return true;
    }
    if (!mutation && band !== slot.band)
      setMessage({
        text: `${item.title} can’t move to ${RADAR_LABELS[slot.band]} with its current status or schedule.`,
        problem: true,
      });
  }

  const { drag, root, startDrag, dragPointer, endDrag } = useItemDrag(
    live,
    commit,
    boardDropSlot,
    () => setMessage(null),
    true,
  );

  function onMoveKey(
    event: KeyboardEvent<HTMLButtonElement>,
    item: CanvasItem,
    band: RadarBand,
    cards: CanvasItem[],
  ) {
    const { key, shiftKey } = event;
    if (
      key !== "ArrowLeft" &&
      key !== "ArrowRight" &&
      key !== "ArrowUp" &&
      key !== "ArrowDown"
    )
      return;
    event.preventDefault();
    setMessage(null);
    const direction = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    const slot: BoardSlot = {
      project: item.project_id,
      band,
      anchor: null,
      side: "after",
    };
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const next = RADAR_BANDS[RADAR_BANDS.indexOf(band) + direction];
      if (!next) return;
      slot.band = next;
    } else if (shiftKey) {
      const index = visibleProjects.findIndex(
        ({ id }) => id === item.project_id,
      );
      const next = visibleProjects[index + direction];
      if (!next) return;
      slot.project = next.id;
    } else {
      if (hasFixedOrder(item)) return;
      const peers = cards.filter(
        (card) => card.status !== "done" && !hasFixedOrder(card),
      );
      const index = peers.findIndex(({ id }) => id === item.id);
      const anchor = peers[index + direction];
      if (!anchor) return;
      slot.anchor = anchor.id;
      slot.side = direction < 0 ? "before" : "after";
    }
    if (commit(item.id, slot)) setKeyboardMove({ id: item.id });
  }

  if (!visibleProjects.length)
    return <GuideEmpty openGuide={openGuide}>No visible projects.</GuideEmpty>;

  return (
    <>
      {!cells.size && (
        <GuideEmpty openGuide={openGuide}>No items in this view.</GuideEmpty>
      )}
      <p
        className={message?.problem ? "stream-move-notice" : "sr-only"}
        aria-live="polite"
      >
        {message?.text}
      </p>
      <p className="sr-only" id="board-move-help">
        Use up and down to reorder, left and right to change time band, and
        Shift with up or down to change project.
      </p>
      <div
        className="board-scroll"
        ref={root}
        tabIndex={0}
        role="region"
        aria-label="Scrollable project board"
      >
        <table className="board" aria-label="Projects by time band">
          <thead>
            <tr>
              <th scope="col">Project</th>
              {RADAR_BANDS.map((band) => (
                <th scope="col" key={band} data-column={band}>
                  {RADAR_LABELS[band]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleProjects.map((project) => (
              <tr key={project.id}>
                <th scope="row">
                  <span className="board-project">
                    <span
                      className="project-dot"
                      style={{ backgroundColor: project.color ?? undefined }}
                      aria-hidden="true"
                    />
                    <span>
                      {project.name}
                      {project.demo === 1 && (
                        <>
                          <br />
                          <DemoBadge />
                        </>
                      )}
                    </span>
                  </span>
                </th>
                {RADAR_BANDS.map((band) => {
                  const cards = cells.get(project.id)?.get(band) ?? [];
                  const slot = drag?.slot;
                  const target =
                    slot?.project === project.id && slot.band === band;
                  const sameCell =
                    target &&
                    drag &&
                    items.get(drag.id)?.project_id === project.id &&
                    placements.get(drag.id) === band;
                  return (
                    <td
                      key={band}
                      data-board-band={band}
                      data-board-project={project.id}
                      data-drop-active={target && !sameCell}
                    >
                      {cards.map((item) => {
                        const ghost = item.status === "done";
                        return (
                          <div
                            key={item.id}
                            className="horizon-row board-card"
                            data-board-card={item.id}
                            data-selected={selectedId === item.id}
                            data-ghost={ghost}
                            data-dragging={drag?.id === item.id}
                            data-insert={
                              sameCell &&
                              !ghost &&
                              slot.anchor === item.id &&
                              drag?.id !== item.id
                                ? slot.side
                                : undefined
                            }
                          >
                            <button
                              type="button"
                              className="stream-select"
                              aria-label={item.title}
                              aria-pressed={selectedId === item.id}
                              aria-describedby={`board-details-${item.id}`}
                              onClick={() => select(item.id)}
                            >
                              <ItemTimeBadge
                                item={item}
                                items={items}
                                formats={formats}
                                upcoming={band !== "today"}
                              />
                              <span className="item-title">{item.title}</span>
                              <ItemMarkers
                                item={item}
                                items={items}
                                dependencies={dependencies}
                                now={now}
                                timezone={timezone}
                                id={`board-details-${item.id}`}
                                showChildCount
                              >
                                {ghost && <span>Completed</span>}
                              </ItemMarkers>
                            </button>
                            {!ghost && (
                              <button
                                className="row-tool drag-handle"
                                type="button"
                                disabled={!live}
                                aria-label={`Move ${item.title}`}
                                aria-describedby="board-move-help"
                                title="Drag to move or use the arrow keys"
                                ref={(node) => {
                                  if (node) handles.current.set(item.id, node);
                                  else handles.current.delete(item.id);
                                }}
                                onKeyDown={(event) =>
                                  onMoveKey(event, item, band, cards)
                                }
                                onPointerDown={(event) =>
                                  startDrag(event, item.id)
                                }
                                onPointerMove={dragPointer}
                                onPointerUp={endDrag}
                                onPointerCancel={endDrag}
                                onLostPointerCapture={endDrag}
                              >
                                ⠿
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
