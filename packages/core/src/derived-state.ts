import type { Dependency, Item, RadarBand } from "./workspace.js";

export const STREAM_BANDS = [
  "done-today",
  "today",
  "tomorrow",
  "this-week",
  "later",
  "backlog",
] as const;

export type Band = (typeof STREAM_BANDS)[number];
export type Ring = "handoff" | "stale" | "reopened" | "blocked" | "live";

type Schedule = Pick<Item, "id" | "parent_id" | "scheduled_on">;
type ScheduledItem = Schedule &
  Pick<Item, "status" | "time_at" | "completed_at">;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function workspaceInstant(value: string | null): number {
  // SQLite datetime('now') produces UTC text without a timezone marker.
  if (value?.includes(" ")) return Date.parse(value.replace(" ", "T") + "Z");
  return value === null ? NaN : Date.parse(value);
}

function calendar(now: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  function localDate(time: number): string {
    const parts = formatter.formatToParts(time);
    const year = parts.find(({ type }) => type === "year")!.value;
    const month = parts.find(({ type }) => type === "month")!.value;
    const day = parts.find(({ type }) => type === "day")!.value;
    return `${year.padStart(4, "0")}-${month}-${day}`;
  }

  const today = localDate(now);
  // UTC midnight is only a coordinate for calendar arithmetic on this date.
  const day = Date.parse(today);
  const daysUntilMonday = 7 - ((new Date(day).getUTCDay() + 6) % 7);
  const dateAfter = (days: number) =>
    new Date(day + days * DAY).toISOString().slice(0, 10);

  return {
    today,
    tomorrow: dateAfter(1),
    nextWeek: dateAfter(daysUntilMonday),
    dateAfter,
    localDate,
    now,
  };
}

export function effectiveSchedule(
  item: Schedule,
  ancestors: ReadonlyMap<string, Schedule>,
): string | null {
  let current: Schedule | undefined = item;
  while (current) {
    if (current.scheduled_on !== null) return current.scheduled_on;
    current =
      current.parent_id === null ? undefined : ancestors.get(current.parent_id);
  }
  return null;
}

function resolveBand(
  item: ScheduledItem,
  schedule: string | null,
  dates: ReturnType<typeof calendar>,
): Band | null {
  if (item.status === "cancelled") return null;
  if (item.status === "done") {
    const completed = workspaceInstant(item.completed_at);
    return Number.isFinite(completed) &&
      dates.localDate(completed) === dates.today
      ? "done-today"
      : null;
  }

  const time = workspaceInstant(item.time_at);
  const timeDate = Number.isFinite(time) ? dates.localDate(time) : null;
  if (
    item.status === "active" ||
    (schedule !== null && schedule <= dates.today) ||
    time <= dates.now ||
    timeDate === dates.today
  ) {
    return "today";
  }

  const date = schedule ?? timeDate;
  if (date === null) return "backlog";
  if (date === dates.tomorrow) return "tomorrow";
  return date < dates.nextWeek ? "this-week" : "later";
}

export function band(
  item: ScheduledItem,
  ancestors: ReadonlyMap<string, Schedule>,
  now: number,
  timezone: string,
): Band | null {
  return resolveBand(
    item,
    effectiveSchedule(item, ancestors),
    calendar(now, timezone),
  );
}

export function bandsFor(
  items: readonly ScheduledItem[],
  ancestors: ReadonlyMap<string, Schedule>,
  now: number,
  timezone: string,
): Map<string, Band | null> {
  const dates = calendar(now, timezone);
  return new Map(
    items.map((item) => [
      item.id,
      resolveBand(item, effectiveSchedule(item, ancestors), dates),
    ]),
  );
}

function toRadarBand(value: Band | null): RadarBand {
  if (value === "tomorrow") return "this-week";
  if (value === "done-today" || value === null) return "today";
  return value;
}

/** Classify completion using the item's placement immediately before it became done. */
export function completionBand(
  item: ScheduledItem,
  ancestors: ReadonlyMap<string, Schedule>,
  now: number,
  timezone: string,
): RadarBand {
  return toRadarBand(
    band(
      { ...item, status: item.status === "active" ? "active" : "queued" },
      ancestors,
      now,
      timezone,
    ),
  );
}

export function radarBandsFor(
  items: readonly (ScheduledItem & Pick<Item, "completed_band">)[],
  ancestors: ReadonlyMap<string, Schedule>,
  now: number,
  timezone: string,
): Map<string, RadarBand> {
  const dates = calendar(now, timezone);
  return new Map(
    items.map((item) => {
      if (item.status === "done") {
        const completed = workspaceInstant(item.completed_at);
        return [
          item.id,
          item.completed_band ??
            completionBand(
              item,
              ancestors,
              Number.isFinite(completed) ? completed : now,
              timezone,
            ),
        ];
      }
      return [
        item.id,
        toRadarBand(
          resolveBand(item, effectiveSchedule(item, ancestors), dates),
        ),
      ];
    }),
  );
}

export function carriedOverFrom(
  item: ScheduledItem,
  ancestors: ReadonlyMap<string, Schedule>,
  now: number,
  timezone: string,
): string | null {
  const schedule = effectiveSchedule(item, ancestors);
  return item.status !== "done" &&
    item.status !== "cancelled" &&
    schedule !== null &&
    schedule < calendar(now, timezone).today
    ? schedule
    : null;
}

export function isLive(
  item: Pick<Item, "status" | "last_heartbeat_at">,
  now: number,
): boolean {
  const age = now - workspaceInstant(item.last_heartbeat_at);
  return item.status === "active" && age >= 0 && age <= 15 * MINUTE;
}

export function isStale(
  item: Pick<Item, "status" | "last_heartbeat_at">,
  now: number,
): boolean {
  const heartbeat = workspaceInstant(item.last_heartbeat_at);
  return (
    item.status === "active" &&
    (Number.isNaN(heartbeat) || now - heartbeat > 15 * MINUTE)
  );
}

export function isBlocked(
  item: Pick<Item, "id" | "status">,
  items: ReadonlyMap<string, Pick<Item, "status">>,
  dependencies: readonly Dependency[],
): boolean {
  return (
    item.status === "blocked" ||
    dependencies.some(({ item_id, blocked_by_id }) => {
      const blocker = items.get(blocked_by_id);
      return (
        item_id === item.id &&
        blocker !== undefined &&
        blocker.status !== "done"
      );
    })
  );
}

export function isGhost(
  item: Pick<Item, "status" | "completed_at">,
  now: number,
): boolean {
  const age = now - workspaceInstant(item.completed_at);
  return item.status === "done" && age >= 0 && age < DAY;
}

export function needsMe(
  item: Pick<Item, "status" | "last_heartbeat_at" | "handoff">,
  now: number,
): boolean {
  return item.handoff === 1 || isStale(item, now);
}

export function needsMeCount(
  items: readonly Pick<Item, "status" | "last_heartbeat_at" | "handoff">[],
  now: number,
): number {
  return items.filter((item) => needsMe(item, now)).length;
}

const RING_ORDER: readonly Ring[] = [
  "handoff",
  "stale",
  "reopened",
  "blocked",
  "live",
];

export function rollUpRing(
  item: Pick<Item, "id">,
  items: readonly Item[],
  dependencies: readonly Dependency[],
  now: number,
): Ring | null {
  const itemsById = new Map(items.map((child) => [child.id, child]));
  const descendants = items.filter((child) => {
    let parent = child.parent_id;
    while (parent !== null) {
      if (parent === item.id) return true;
      parent = itemsById.get(parent)?.parent_id ?? null;
    }
    return false;
  });
  const checks: Record<Ring, (child: Item) => boolean> = {
    handoff: (child) => child.handoff === 1,
    stale: (child) => isStale(child, now),
    reopened: (child) =>
      child.reopen_count > 0 &&
      child.status !== "done" &&
      child.status !== "cancelled",
    blocked: (child) => isBlocked(child, itemsById, dependencies),
    live: (child) => isLive(child, now),
  };
  return RING_ORDER.find((ring) => descendants.some(checks[ring])) ?? null;
}

export function progress(
  item: Pick<Item, "id">,
  items: readonly Pick<Item, "parent_id" | "status">[],
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const child of items) {
    if (child.parent_id !== item.id || child.status === "cancelled") continue;
    total++;
    if (child.status === "done") done++;
  }
  return { done, total };
}

export function agentsLive(
  items: readonly Pick<Item, "status" | "last_heartbeat_at" | "agent_name">[],
  now: number,
): string[] {
  const agents = new Set<string>();
  for (const item of items) {
    if (item.agent_name !== null && isLive(item, now))
      agents.add(item.agent_name);
  }
  return [...agents];
}

function streamSortKey(
  item: Pick<Item, "time_type" | "time_at" | "sort_key" | "priority">,
) {
  const time = workspaceInstant(item.time_at);
  if (item.time_type === "fixed" && Number.isFinite(time)) return [0, time];
  if (item.sort_key !== null) return [1, item.sort_key];
  return [2, -item.priority];
}

export function streamOrder<
  T extends Pick<Item, "time_type" | "time_at" | "sort_key" | "priority">,
>(items: readonly T[]): T[] {
  return items
    .map((item) => ({ item, key: streamSortKey(item) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
    .map(({ item }) => item);
}

type StreamItem = ScheduledItem &
  Pick<Item, "time_type" | "sort_key" | "priority" | "hidden">;
export interface StreamRow<T = Item> {
  item: T;
  children: StreamRow<T>[];
}

export function streamRows<T extends StreamItem>(
  items: readonly T[],
  now: number,
  timezone: string,
): Record<Band, StreamRow<T>[]> {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const bands = bandsFor(items, itemsById, now, timezone);
  const rowsById = new Map(
    items.map((item) => [item.id, { item, children: [] } as StreamRow<T>]),
  );
  const rows: Record<Band, StreamRow<T>[]> = {
    "done-today": [],
    today: [],
    tomorrow: [],
    "this-week": [],
    later: [],
    backlog: [],
  };
  for (const item of streamOrder(items)) {
    const itemBand = bands.get(item.id);
    if (!itemBand) continue;

    let root: T | undefined = item;
    while (root && root.parent_id !== null) {
      root = itemsById.get(root.parent_id);
    }
    if (root?.hidden === 1) continue;

    const row = rowsById.get(item.id)!;
    if (item.parent_id !== null && bands.get(item.parent_id) === itemBand) {
      rowsById.get(item.parent_id)!.children.push(row);
    } else {
      rows[itemBand].push(row);
    }
  }
  return rows;
}

/**
 * Returns the earliest scheduling date for a band. Null clears the schedule
 * for Backlog or indicates that the band has no schedulable date.
 */
export function firstDayOfBand(
  band: Band,
  now: number,
  timezone: string,
): string | null {
  const dates = calendar(now, timezone);
  switch (band) {
    case "today":
      return dates.today;
    case "tomorrow":
      return dates.tomorrow;
    case "this-week": {
      const first = dates.dateAfter(2);
      return first < dates.nextWeek ? first : null;
    }
    case "later":
      return dates.nextWeek === dates.tomorrow
        ? dates.dateAfter(2)
        : dates.nextWeek;
    case "backlog":
    case "done-today":
      return null;
  }
}
