import { GuideEmpty } from "./Onboarding";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  firstDayOfBand,
  needsMe,
  STREAM_BANDS,
  streamOrder,
  type Band,
  type StreamRow,
} from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import {
  hasFixedOrder,
  reorderMove,
  scheduleMove,
  type StreamMove,
} from "./stream-move";
import { streamDropSlot, useItemDrag, type DropSlot } from "./use-item-drag";
import { ItemMarkers, ItemTimeBadge, itemTimeFormats } from "./item-markers";
import type { WorkspaceData } from "./workspace-state";
import type { selectWorkspace } from "./workspace-view";

const labels: Record<Band, string> = {
  "done-today": "Completed earlier today",
  today: "Today",
  tomorrow: "Tomorrow",
  "this-week": "This week",
  later: "Later",
  backlog: "Backlog",
};

type WorkspaceSelection = ReturnType<typeof selectWorkspace>;
type Row = StreamRow<CanvasItem>;
type BandRows = Record<Band, Row[]>;

type IndexedRow = { row: Row; band: Band; path: string[]; siblings: Row[] };

interface Props extends Pick<
  WorkspaceSelection,
  "bands" | "allBands" | "projects" | "attentionCount" | "timezone"
> {
  items: WorkspaceData["items"];
  dependencies: WorkspaceData["dependencies"];
  ready: boolean;
  openGuide?: () => void;
  live: boolean;
  now: number;
  attentionOnly: boolean;
  condensed: boolean;
  todayOnly: boolean;
  toggleAttention: () => void;
  /** Extra stream filters rendered beside Needs me. */
  actions?: ReactNode;
  selectedId: string | null;
  lensSelection: LensSelection | null;
  select: (id: string) => void;
  move: (mutation: StreamMove) => boolean;
  showHistory: () => void;
}

export type LensSelection = { id: string; scrollStreamOnly?: boolean };

function indexRows(bands: BandRows) {
  const index = new Map<string, IndexedRow>();
  function visit(siblings: Row[], band: Band, path: string[]) {
    for (const row of siblings) {
      index.set(row.item.id, { row, band, path, siblings });
      visit(row.children, band, [...path, row.item.id]);
    }
  }
  for (const band of STREAM_BANDS) visit(bands[band], band, []);
  return index;
}

function filterTag(rows: Row[], tag: string): Row[] {
  return rows.flatMap(({ item, children }) => {
    const matching = filterTag(children, tag);
    return matching.length || tagsOf(item).includes(tag)
      ? [{ item, children: matching }]
      : [];
  });
}

function tagsOf(item: CanvasItem): string[] {
  return JSON.parse(item.tags) as string[];
}

function safeLink(value: string | null) {
  if (!value) return null;
  const protocol = URL.parse(value)?.protocol;
  return protocol === "https:" || protocol === "http:" ? value : null;
}

export function HorizonStream({
  bands,
  allBands,
  projects,
  attentionCount,
  items,
  dependencies,
  ready,
  openGuide,
  live,
  now,
  timezone,
  attentionOnly,
  condensed,
  todayOnly,
  toggleAttention,
  actions,
  selectedId,
  lensSelection,
  select,
  move,
  showHistory,
}: Props) {
  const [expanded, setExpanded] = useState(new Map<string, boolean>());
  const [tag, setTag] = useState("");
  const [message, setMessage] = useState<{
    text: string;
    problem?: boolean;
  } | null>(null);
  const [keyboardMove, setKeyboardMove] = useState<{ id: string } | null>(null);
  const handledKeyboardMove = useRef<typeof keyboardMove>(null);
  const revealFrame = useRef(0);
  const rowNodes = useRef(new Map<string, HTMLElement>());
  const allRows = useMemo(() => indexRows(allBands), [allBands]);
  const visibleRows = useMemo(() => indexRows(bands), [bands]);
  const revealedSelection = useRef<typeof lensSelection>(null);
  const backlog = useMemo(
    () => (tag ? filterTag(bands.backlog, tag) : bands.backlog),
    [bands.backlog, tag],
  );
  const shownRows = useMemo(
    () => indexRows({ ...bands, backlog }),
    [bands, backlog],
  );
  const backlogTags = useMemo(
    () =>
      [
        ...new Set(
          [...visibleRows.values()].flatMap(({ band, row }) =>
            band === "backlog" ? tagsOf(row.item) : [],
          ),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [visibleRows],
  );
  const childRows = useMemo(() => {
    const children = new Map<string, CanvasItem[]>();
    for (const {
      row: { item },
    } of visibleRows.values()) {
      if (!item.parent_id) continue;
      const siblings = children.get(item.parent_id) ?? [];
      siblings.push(item);
      children.set(item.parent_id, siblings);
    }
    return children;
  }, [visibleRows]);

  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const edges = [...dependencies.values()];
  const formats = useMemo(() => itemTimeFormats(timezone), [timezone]);
  const movableBands = STREAM_BANDS.filter(
    (band) =>
      band !== "done-today" &&
      (band !== "this-week" ||
        bands[band].length > 0 ||
        firstDayOfBand(band, now, timezone) !== null),
  );

  useLayoutEffect(() => {
    const fromLens =
      lensSelection !== revealedSelection.current ? lensSelection : null;
    const fromKeyboard =
      keyboardMove !== handledKeyboardMove.current ? keyboardMove : null;
    const request = fromLens ?? fromKeyboard;
    if (!request) return;
    const target = visibleRows.get(request.id);
    if (!target) return;
    revealedSelection.current = lensSelection;
    handledKeyboardMove.current = keyboardMove;
    const { band, path, row } = target;
    const group =
      visibleRows.get(path[0])?.row.item.project_id ?? row.item.project_id;
    setExpanded((previous) => {
      const next = new Map(previous);
      if (band === "done-today") next.set("completed", true);
      if (band === "backlog") next.set(`project:${group}`, true);
      for (const id of path) next.set(`row:${id}`, true);
      return next;
    });
    if (band === "backlog") setTag("");
    cancelAnimationFrame(revealFrame.current);
    revealFrame.current = requestAnimationFrame(() => {
      const rowNode = rowNodes.current.get(row.item.id);
      if (fromLens?.scrollStreamOnly && rowNode) {
        // Keep the treemap in place so a second tap can reach the same tile.
        const stream = rowNode.closest<HTMLElement>(".stream-content");
        if (!stream) return;
        const rowBounds = rowNode.getBoundingClientRect();
        const streamBounds = stream.getBoundingClientRect();
        if (rowBounds.top < streamBounds.top)
          stream.scrollTop += rowBounds.top - streamBounds.top;
        else if (rowBounds.bottom > streamBounds.bottom)
          stream.scrollTop += rowBounds.bottom - streamBounds.bottom;
      } else if (fromLens) rowNode?.scrollIntoView?.({ block: "nearest" });
      else rowNode?.querySelector<HTMLButtonElement>(".drag-handle")?.focus();
    });
  }, [keyboardMove, lensSelection, visibleRows]);

  useEffect(() => () => cancelAnimationFrame(revealFrame.current), []);

  function toggle(key: string, open: boolean) {
    setExpanded((previous) => new Map(previous).set(key, !open));
  }

  function peers(source: IndexedRow) {
    return source.band === "backlog" && !source.path.length
      ? source.siblings.filter(
          ({ item }) => item.project_id === source.row.item.project_id,
        )
      : source.siblings;
  }

  function commit(id: string, slot: DropSlot | null) {
    const source = allRows.get(id);
    if (!slot || !source || !live || slot.band === "done-today") return;
    const { item } = source.row;
    const siblings = peers(source);
    if (
      source.band === slot.band &&
      slot.anchor &&
      !siblings.some(({ item }) => item.id === slot.anchor)
    ) {
      setMessage({
        text: "Reorder items alongside their siblings.",
        problem: true,
      });
      return;
    }
    const mutation =
      source.band !== slot.band
        ? scheduleMove(item, slot.band, items, now, timezone)
        : reorderMove(
            siblings.map(({ item }) => item),
            id,
            slot.anchor,
            slot.side,
          );
    if (!mutation) {
      if (source.band !== slot.band)
        setMessage({
          text: `${item.title} can’t move to ${labels[slot.band]} with its current status or schedule.`,
          problem: true,
        });
      return;
    }
    if (move(mutation)) {
      setMessage({
        text:
          source.band === slot.band
            ? `Moved ${item.title} within ${labels[slot.band]}.`
            : `Moved ${item.title} to ${labels[slot.band]}.`,
      });
      if (slot.band === "backlog" && source.band !== "backlog") {
        setTag("");
        setExpanded((previous) =>
          new Map(previous).set(`project:${item.project_id}`, true),
        );
      }
      return true;
    }
  }

  function onMoveKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const { key } = event;
    if (
      key !== "ArrowUp" &&
      key !== "ArrowDown" &&
      key !== "ArrowLeft" &&
      key !== "ArrowRight"
    )
      return;
    const row = shownRows.get(id);
    if (!row) return;
    event.preventDefault();
    setMessage(null);
    const direction = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const target = movableBands[movableBands.indexOf(row.band) + direction];
      if (target && commit(id, { band: target, anchor: null, side: "after" })) {
        setKeyboardMove({ id });
      }
      return;
    }
    if (hasFixedOrder(row.row.item)) return;
    const siblings = peers(row).filter(({ item }) => !hasFixedOrder(item));
    const index = siblings.findIndex(({ item }) => item.id === id);
    const anchor = siblings[index + direction]?.item.id;
    if (
      anchor &&
      commit(id, {
        band: row.band,
        anchor,
        side: direction < 0 ? "before" : "after",
      })
    )
      setKeyboardMove({ id });
  }

  const { drag, root, startDrag, dragPointer, endDrag } = useItemDrag(
    live,
    commit,
    streamDropSlot,
    () => setMessage(null),
  );

  function renderRows(rows: Row[], band: Band, path = "") {
    return (
      <ul className="item-list">
        {rows.map(({ item, children }) => {
          const canonical = visibleRows.get(item.id)!;
          const attention = path === "attention/";
          const alias =
            attention || canonical.band !== band || path.startsWith("alias/");
          const key = `row:${alias ? path : ""}${item.id}`;
          const open = expanded.get(key) ?? attentionOnly;
          const link = safeLink(item.ref_url);
          const detailId = `stream-details-${encodeURIComponent(path)}${encodeURIComponent(item.id)}`;
          const upcoming =
            canonical.band !== "today" && canonical.band !== "done-today";
          const childrenById = new Map(
            children.map((child) => [child.item.id, child]),
          );
          if (!attention && (band !== "backlog" || !tag)) {
            for (const child of childRows.get(item.id) ?? []) {
              const entry = visibleRows.get(child.id)!;
              if (entry.band !== canonical.band)
                childrenById.set(child.id, entry.row);
            }
          }
          const shownChildren = streamOrder(
            [...childrenById.values()].map(({ item }) => item),
          ).map(({ id }) => childrenById.get(id)!);
          const slot = drag?.slot;
          return (
            <li key={item.id}>
              <div
                className="horizon-row"
                data-selected={selectedId === item.id}
                data-stream-alias={alias || undefined}
                data-drop-row={alias ? undefined : item.id}
                data-dragging={!alias && drag?.id === item.id}
                data-insert={
                  !alias &&
                  slot?.band === band &&
                  slot.anchor === item.id &&
                  drag?.id !== item.id
                    ? slot.side
                    : undefined
                }
                ref={(node) => {
                  if (alias && !attention) return;
                  if (node) rowNodes.current.set(item.id, node);
                  else rowNodes.current.delete(item.id);
                }}
              >
                {shownChildren.length > 0 && (
                  <button
                    className="row-tool row-expander"
                    type="button"
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${item.title}`}
                    onClick={() => toggle(key, open)}
                  >
                    {open ? "▾" : "▸"}
                  </button>
                )}
                <button
                  type="button"
                  className="stream-select"
                  aria-label={item.title}
                  aria-describedby={detailId}
                  aria-pressed={selectedId === item.id}
                  onClick={() => select(item.id)}
                >
                  <span className="stream-title">
                    <ItemTimeBadge
                      item={item}
                      items={items}
                      formats={formats}
                      upcoming={upcoming}
                      completed={band === "done-today"}
                    />
                    <span className="item-title">{item.title}</span>
                  </span>
                  <ItemMarkers
                    item={item}
                    items={items}
                    dependencies={edges}
                    now={now}
                    timezone={timezone}
                    id={detailId}
                    leading={<span>{projectNames.get(item.project_id)}</span>}
                  >
                    {(attention || (alias && canonical.band !== band)) && (
                      <span>{labels[canonical.band]}</span>
                    )}
                  </ItemMarkers>
                </button>
                {link && (
                  <a
                    className="row-tool stream-link"
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open reference for ${item.title}`}
                  >
                    ↗
                  </a>
                )}
                {!alias && band !== "done-today" && (
                  <button
                    className="row-tool drag-handle"
                    type="button"
                    disabled={!live}
                    aria-label={`Move ${item.title}`}
                    aria-describedby="stream-move-help"
                    title="Drag to move or use the arrow keys"
                    onKeyDown={(event) => onMoveKey(event, item.id)}
                    onPointerDown={(event) => startDrag(event, item.id)}
                    onPointerMove={dragPointer}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={endDrag}
                  >
                    ⠿
                  </button>
                )}
              </div>
              {open &&
                shownChildren.length > 0 &&
                renderRows(
                  shownChildren,
                  band,
                  `${alias && !path.startsWith("alias/") ? "alias/" : ""}${path}${item.id}/`,
                )}
            </li>
          );
        })}
      </ul>
    );
  }

  function renderBand(band: Band, title: string, rows: Row[]) {
    return (
      <section
        className="stream-band"
        aria-label={title}
        data-stream-band={band}
        data-drop-active={
          drag?.slot?.band === band && allRows.get(drag.id)?.band !== band
        }
      >
        <h3>{title}</h3>
        {rows.length ? (
          renderRows(rows, band)
        ) : (
          <p className="stream-empty">No items scheduled.</p>
        )}
      </section>
    );
  }

  const completed = expanded.get("completed") ?? true;
  const attentionRows = condensed
    ? streamOrder(
        [...visibleRows.values()]
          .map(({ row }) => row.item)
          .filter((item) => item.status !== "done" && needsMe(item, now)),
      ).map((item) => ({ item, children: [] }))
    : [];

  return (
    <>
      <div className="section-heading stream-heading">
        <h2 id="stream-heading">Horizon Stream</h2>
        <div className="inline-actions">
          <button
            type="button"
            className="attention-button"
            aria-pressed={attentionOnly}
            onClick={toggleAttention}
          >
            Needs me <span>{attentionCount}</span>
          </button>
          {actions}
        </div>
      </div>
      <p
        className={message?.problem ? "stream-move-notice" : "sr-only"}
        aria-live="polite"
      >
        {message?.text}
      </p>
      <div className="stream-content" ref={root} data-moving={drag !== null}>
        <p className="sr-only" id="stream-move-help">
          Use up and down to reorder. Use left and right to move between bands.
        </p>
        {ready && (
          <>
            {condensed && !visibleRows.size && (
              <GuideEmpty
                className="stream-empty stream-overview"
                openGuide={openGuide}
              >
                {attentionOnly
                  ? "Nothing needs your input."
                  : "No items in the stream yet."}
              </GuideEmpty>
            )}
            {condensed && (
              <section
                className="stream-band"
                aria-labelledby="stream-attention-heading"
              >
                <h3 id="stream-attention-heading">Needs me</h3>
                {attentionRows.length > 0 ? (
                  renderRows(attentionRows, "today", "attention/")
                ) : (
                  <p className="stream-empty">Nothing needs your input.</p>
                )}
              </section>
            )}
            {!todayOnly && bands["done-today"].length > 0 && (
              <section className="stream-band stream-completed">
                <h3>
                  <button
                    className="stream-disclosure"
                    type="button"
                    aria-expanded={completed}
                    onClick={() => toggle("completed", completed)}
                  >
                    <span aria-hidden="true">{completed ? "▾" : "▸"}</span>{" "}
                    Completed earlier today{" "}
                    <span className="stream-count">
                      {bands["done-today"].length}
                    </span>
                  </button>
                </h3>
                {completed && renderRows(bands["done-today"], "done-today")}
              </section>
            )}
            {condensed && !bands["done-today"].length && (
              <section className="stream-band stream-completed">
                <h3>Completed earlier today</h3>
                <p className="stream-empty">No items completed today.</p>
              </section>
            )}
            {!condensed && (
              <>
                <div className="now-divider">
                  <span>
                    Now{" "}
                    <time dateTime={new Date(now).toISOString()}>
                      {formats.clock.format(now)}
                    </time>
                  </span>
                </div>
                {(todayOnly ? !bands.today.length : !visibleRows.size) && (
                  <GuideEmpty
                    className="stream-empty stream-overview"
                    openGuide={openGuide}
                  >
                    {attentionOnly
                      ? "Nothing needs your input."
                      : todayOnly && visibleRows.size
                        ? "Nothing scheduled for today."
                        : "No items in the stream yet."}
                  </GuideEmpty>
                )}
                {renderBand("today", "Today", bands.today)}
                {!todayOnly && (
                  <>
                    <section
                      className="stream-upcoming"
                      aria-labelledby="upcoming-heading"
                    >
                      <h3 id="upcoming-heading">Tomorrow &amp; this week</h3>
                      {renderBand("tomorrow", "Tomorrow", bands.tomorrow)}
                      {movableBands.includes("this-week") &&
                        renderBand(
                          "this-week",
                          "This week",
                          bands["this-week"],
                        )}
                    </section>
                    {renderBand("later", "Later", bands.later)}
                    <section
                      className="stream-band stream-backlog"
                      data-stream-band="backlog"
                      data-drop-active={
                        drag?.slot?.band === "backlog" &&
                        allRows.get(drag.id)?.band !== "backlog"
                      }
                    >
                      <div className="backlog-heading">
                        <h3>Backlog</h3>
                        {(tag || backlogTags.length > 0) && (
                          <select
                            aria-label="Filter backlog by tag"
                            value={tag}
                            onChange={(event) => setTag(event.target.value)}
                          >
                            <option value="">All tags</option>
                            {tag && !backlogTags.includes(tag) && (
                              <option value={tag}>#{tag}</option>
                            )}
                            {backlogTags.map((value) => (
                              <option key={value} value={value}>
                                #{value}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      {backlog.length === 0 && (
                        <p className="stream-empty">
                          {tag
                            ? "No backlog items match this tag."
                            : "No items in the backlog."}
                        </p>
                      )}
                      {projects.map(({ id, name }) => {
                        const rows = backlog.filter(
                          ({ item }) => item.project_id === id,
                        );
                        if (!rows.length) return null;
                        const key = `project:${id}`;
                        const open =
                          expanded.get(key) ?? (attentionOnly || tag !== "");
                        return (
                          <div className="backlog-group" key={id}>
                            <button
                              type="button"
                              className="stream-disclosure"
                              aria-expanded={open}
                              onClick={() => toggle(key, open)}
                            >
                              <span aria-hidden="true">{open ? "▾" : "▸"}</span>{" "}
                              {name}{" "}
                              <span className="stream-count">
                                {rows.length}
                              </span>
                            </button>
                            {open && renderRows(rows, "backlog")}
                          </div>
                        );
                      })}
                    </section>
                  </>
                )}
              </>
            )}
          </>
        )}
        {!todayOnly && (
          <footer className="stream-footer">
            <a
              href="#history"
              onClick={(event) => {
                event.preventDefault();
                showHistory();
              }}
            >
              View history <span aria-hidden="true">→</span>
            </a>
          </footer>
        )}
      </div>
    </>
  );
}
