import type { ReactNode } from "react";
import {
  carriedOverFrom,
  effectiveSchedule,
  isBlocked,
  isLive,
  isStale,
  workspaceInstant,
} from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import type { Dependency } from "../shared/workspace";

const timeLabels = { flexible: "FLEX", fixed: "FIXED", deadline: "DUE" };
const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "always",
});
const calendarDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const weekday = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  timeZone: "UTC",
});

function lastSeen(value: string | null, now: number) {
  const time = workspaceInstant(value);
  if (!Number.isFinite(time)) return "no heartbeat yet";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 60)
    return `last seen ${relativeTime.format(-minutes, "minute")}`;
  if (minutes < 1440)
    return `last seen ${relativeTime.format(-Math.floor(minutes / 60), "hour")}`;
  return `last seen ${relativeTime.format(-Math.floor(minutes / 1440), "day")}`;
}

export function itemTimeFormats(timezone: string) {
  return {
    clock: new Intl.DateTimeFormat(undefined, {
      timeStyle: "short",
      timeZone: timezone,
    }),
    dateTime: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }),
  };
}

export function ItemTimeBadge({
  item,
  items,
  formats,
  upcoming,
  completed,
}: {
  item: CanvasItem;
  items: ReadonlyMap<string, CanvasItem>;
  formats: ReturnType<typeof itemTimeFormats>;
  upcoming: boolean;
  completed?: boolean;
}) {
  const time = workspaceInstant(item.time_at);
  const schedule = effectiveSchedule(item, items);
  const scheduleLabel = Number.isFinite(time)
    ? formats[upcoming ? "dateTime" : "clock"].format(time)
    : upcoming && schedule
      ? calendarDate.format(new Date(schedule))
      : null;
  return (
    <span className="time-badge" data-time-type={item.time_type}>
      {completed && item.completed_at ? (
        formats.clock.format(workspaceInstant(item.completed_at))
      ) : (
        <>
          <span>{timeLabels[item.time_type]}</span>
          {scheduleLabel && <span>{scheduleLabel}</span>}
        </>
      )}
    </span>
  );
}

export function ItemMarkers({
  item,
  items,
  dependencies,
  now,
  timezone,
  leading,
  children,
  id,
  showChildCount,
}: {
  item: CanvasItem;
  items: ReadonlyMap<string, CanvasItem>;
  dependencies: readonly Dependency[];
  now: number;
  timezone: string;
  leading?: ReactNode;
  children?: ReactNode;
  id?: string;
  showChildCount?: boolean;
}) {
  const active = isLive(item, now);
  const stale = isStale(item, now);
  const carried = carriedOverFrom(item, items, now, timezone);
  const { done, total } = item.progress;
  return (
    <span className="stream-meta" id={id}>
      {leading}
      {(item.agent_name || stale || active) && (
        <span className="stream-agent">
          {active && (
            <span className="live-pulse" role="img" aria-label="Live" />
          )}
          {item.agent_name ?? (active ? "Live" : "Agent")}
          {stale && ` · ${lastSeen(item.last_heartbeat_at, now)}`}
        </span>
      )}
      {total > 0 && (
        <span aria-label={`${done} of ${total} children complete`}>
          {done}/{total}
          {showChildCount && " complete"}
        </span>
      )}
      {item.handoff === 1 && <span className="stream-flag">Handoff</span>}
      {item.reopen_count > 0 && item.status !== "done" && (
        <span className="stream-flag">Reopened</span>
      )}
      {isBlocked(item, items, dependencies) && (
        <span className="stream-flag">Blocked</span>
      )}
      {carried && (
        <span className="stream-carried">
          <time dateTime={carried}>
            from {weekday.format(new Date(carried))}
          </time>
        </span>
      )}
      {children}
    </span>
  );
}
