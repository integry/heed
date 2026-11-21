import {
  effectiveSchedule,
  workspaceInstant,
  type CanvasItem,
  type StreamRow,
} from "@heedwork/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { lastSeen } from "./RadarBubble";
import type { AttentionGroup, AttentionGroups } from "./workspace-view";

const labels: Record<AttentionGroup, string> = {
  needs: "Needs you",
  working: "Working now",
  today: "Today",
  done: "Done",
  week: "This week",
};

type RowProps = {
  group: AttentionGroup;
  items: ReadonlyMap<string, CanvasItem>;
  formats: ReturnType<typeof streamTimeFormats>;
  collapsed: ReadonlySet<string>;
  toggle: (id: string) => void;
  now: number;
  selectedId: string | null;
  select: (id: string) => void;
};

const scheduledDay = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  timeZone: "UTC",
});

function streamTimeFormats(timezone: string) {
  return {
    time: new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }),
    weekday: new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      timeZone: timezone,
    }),
  };
}

function rowTime({
  item,
  group,
  formats,
  items,
}: Pick<RowProps, "group" | "formats" | "items"> & { item: CanvasItem }) {
  if (group === "working") return "now";
  const timestamp = workspaceInstant(
    group === "done" ? item.completed_at : item.time_at,
  );
  if (group === "week") {
    const scheduled = effectiveSchedule(item, items);
    if (scheduled) return scheduledDay.format(Date.parse(scheduled));
    if (Number.isFinite(timestamp)) return formats.weekday.format(timestamp);
  } else if (Number.isFinite(timestamp)) {
    return formats.time.format(timestamp);
  }
  return "·";
}

function Rows({
  rows,
  id: listId,
  ...props
}: RowProps & { rows: StreamRow<CanvasItem>[]; id?: string }) {
  const { group, now, selectedId, select, collapsed, toggle } = props;
  const prefix = useId();
  return (
    <ul className="attention-rows" id={listId}>
      {rows.map(({ item, children }) => {
        const stamp = rowTime({ item, ...props });
        const expanded = !collapsed.has(item.id);
        const detail =
          group === "needs" && !item.handoff
            ? lastSeen(item.last_heartbeat_at, now)
            : group === "needs"
              ? item.handoff_note
              : group === "working"
                ? item.note
                : item.time_type === "fixed"
                  ? "fixed time"
                  : null;

        const id = `${prefix}-${item.id}`;
        return (
          <li
            key={item.id}
            data-has-children={children.length > 0 || undefined}
          >
            <button
              className="attention-row"
              type="button"
              aria-labelledby={`${id}-title`}
              aria-describedby={
                stamp === "·" ? `${id}-agent` : `${id}-time ${id}-agent`
              }
              aria-pressed={selectedId === item.id}
              onClick={() => select(item.id)}
            >
              <span
                id={`${id}-time`}
                className="attention-time"
                aria-hidden={stamp === "·"}
              >
                {stamp}
              </span>
              <span className="attention-copy">
                <span id={`${id}-title`} className="attention-title">
                  {item.title}
                </span>
                <span id={`${id}-agent`} className="attention-agent">
                  {item.agent_name ??
                    (item.created_by === "human" ? "you" : "Agent")}
                  {detail && ` · ${detail}`}
                </span>
              </span>
            </button>
            {children.length > 0 && (
              <>
                <button
                  className="text-control attention-expand"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={expanded ? `${id}-children` : undefined}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${item.title}`}
                  onClick={() => toggle(item.id)}
                >
                  {expanded ? "−" : "+"}
                </button>
                {expanded && (
                  <Rows id={`${id}-children`} rows={children} {...props} />
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AttentionStream({
  groups,
  items,
  timezone,
  now,
  selectedId,
  select,
  radarSelection,
}: Pick<RowProps, "items" | "now" | "selectedId" | "select"> & {
  groups: AttentionGroups;
  timezone: string;
  radarSelection: string | null;
}) {
  const list = useRef<HTMLElement>(null);
  const id = useId();
  const formats = useMemo(() => streamTimeFormats(timezone), [timezone]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!selectedId) return;
    setCollapsed((previous) => {
      let next: Set<string> | undefined;
      let parent = items.get(selectedId)?.parent_id;
      while (parent) {
        if (previous.has(parent)) {
          next ??= new Set(previous);
          next.delete(parent);
        }
        parent = items.get(parent)?.parent_id;
      }
      return next ?? previous;
    });
  }, [items, selectedId]);

  useEffect(() => {
    // Preserve the field in view on phones. The selected row is still marked.
    if (radarSelection && window.matchMedia?.("(min-width: 761px)").matches)
      list.current
        ?.querySelector('[aria-pressed="true"]')
        ?.scrollIntoView?.({ block: "nearest" });
  }, [collapsed, radarSelection]);

  function toggle(itemId: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  return (
    <aside ref={list} className="attention-stream" aria-label="Day stream">
      {(Object.keys(labels) as AttentionGroup[]).map(
        (group) =>
          groups[group].length > 0 && (
            <section
              key={group}
              data-group={group}
              aria-labelledby={`${id}-${group}`}
            >
              <h2 id={`${id}-${group}`}>{labels[group]}</h2>
              <Rows
                rows={groups[group]}
                group={group}
                items={items}
                formats={formats}
                collapsed={collapsed}
                toggle={toggle}
                now={now}
                selectedId={selectedId}
                select={select}
              />
            </section>
          ),
      )}
    </aside>
  );
}
