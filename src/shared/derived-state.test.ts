import { describe, expect, it } from "vitest";
import {
  agentsLive,
  band,
  carriedOverFrom,
  effectiveSchedule,
  firstDayOfBand,
  isBlocked,
  isGhost,
  isLive,
  isStale,
  needsMe,
  needsMeCount,
  progress,
  rollUpRing,
  streamOrder,
  streamRows,
} from "./derived-state";
import type { Item } from "./workspace";

const now = Date.parse("2024-04-03T12:00:00Z");
const utc = "UTC";

function item(id: string, patch: Partial<Item> = {}): Item {
  return {
    id,
    project_id: "inbox",
    parent_id: null,
    external_key: null,
    title: id,
    tags: "[]",
    depth: 1,
    priority: 5,
    scheduled_on: null,
    sort_key: null,
    layout_pos: "{}",
    locked_fields: "[]",
    time_type: "flexible",
    time_at: null,
    status: "queued",
    handoff: 0,
    handoff_note: null,
    reopen_count: 0,
    reopen_reason: null,
    agent_name: null,
    created_by: "human",
    ref_url: null,
    note: null,
    hidden: 0,
    last_heartbeat_at: null,
    completed_at: null,
    created_at: "2024-04-01 00:00:00",
    updated_at: "2024-04-01 00:00:00",
    ...patch,
  };
}

function index(items: Item[]) {
  return new Map(items.map((item) => [item.id, item]));
}

describe("scheduling", () => {
  it.each([
    ["backlog", {}, "backlog"],
    ["active without a date", { status: "active" }, "today"],
    [
      "active with a future date",
      { status: "active", scheduled_on: "2024-05-01" },
      "today",
    ],
    ["carried over", { scheduled_on: "2024-04-02" }, "today"],
    ["scheduled today", { scheduled_on: "2024-04-03" }, "today"],
    [
      "past deadline with future schedule",
      {
        scheduled_on: "2024-04-09",
        time_at: "2024-04-02T23:59:00Z",
        time_type: "deadline",
      },
      "today",
    ],
    ["time later today", { time_at: "2024-04-03T23:59:00Z" }, "today"],
    ["scheduled tomorrow", { scheduled_on: "2024-04-04" }, "tomorrow"],
    [
      "schedule takes precedence over future time",
      { scheduled_on: "2024-04-05", time_at: "2024-04-04T23:59:00Z" },
      "this-week",
    ],
    [
      "future time without a schedule",
      { time_at: "2024-04-04T23:59:00Z" },
      "tomorrow",
    ],
    ["Sunday", { scheduled_on: "2024-04-07" }, "this-week"],
    ["next Monday", { scheduled_on: "2024-04-08" }, "later"],
    [
      "done today",
      { status: "done", completed_at: "2024-04-03 01:00:00" },
      "done-today",
    ],
    [
      "done yesterday",
      { status: "done", completed_at: "2024-04-02T23:00:00Z" },
      null,
    ],
    ["cancelled", { status: "cancelled", scheduled_on: "2024-04-03" }, null],
  ] satisfies [string, Partial<Item>, string | null][])(
    "%s",
    (_, patch, expected) => {
      expect(band(item("item", patch), new Map(), now, utc)).toBe(expected);
    },
  );

  const ancestors = index([
    item("goal", { scheduled_on: "2024-04-01" }),
    item("parent", { parent_id: "goal" }),
    item("scheduled", { parent_id: "goal", scheduled_on: "2024-04-04" }),
  ]);

  it.each([
    [{ parent_id: "parent" }, "2024-04-01", "2024-04-01", "today"],
    [{ parent_id: "scheduled" }, "2024-04-04", null, "tomorrow"],
    [
      { parent_id: "parent", scheduled_on: "2024-04-05" },
      "2024-04-05",
      null,
      "this-week",
    ],
    [{ parent_id: "parent", status: "done" }, "2024-04-01", null, null],
    [{ time_at: "2024-04-02T00:00:00Z" }, null, null, "today"],
    [{ parent_id: "missing" }, null, null, "backlog"],
  ] satisfies [Partial<Item>, string | null, string | null, string | null][])(
    "resolves schedule and carry-over for %j",
    (patch, schedule, carryOver, expectedBand) => {
      const child = item("child", patch);
      expect(effectiveSchedule(child, ancestors)).toBe(schedule);
      expect(carriedOverFrom(child, ancestors, now, utc)).toBe(carryOver);
      expect(band(child, ancestors, now, utc)).toBe(expectedBand);
    },
  );

  it.each([
    [
      "Europe/Tallinn",
      "2024-03-30T21:59:59Z",
      "2024-03-30T22:00:00Z",
      "2024-03-31",
      "2024-04-01",
    ],
    [
      "Europe/Tallinn",
      "2024-03-31T20:59:59Z",
      "2024-03-31T21:00:00Z",
      "2024-04-01",
      "2024-04-02",
    ],
    [
      "America/Los_Angeles",
      "2024-03-10T07:59:59Z",
      "2024-03-10T08:00:00Z",
      "2024-03-10",
      "2024-03-11",
    ],
    [
      "America/Los_Angeles",
      "2024-03-11T06:59:59Z",
      "2024-03-11T07:00:00Z",
      "2024-03-11",
      "2024-03-12",
    ],
    [
      "Pacific/Kiritimati",
      "2024-12-31T09:59:59Z",
      "2024-12-31T10:00:00Z",
      "2025-01-01",
      "2025-01-02",
    ],
  ])(
    "uses local midnight in %s at %s",
    (zone, before, after, localDay, tomorrow) => {
      const scheduled = item("scheduled", { scheduled_on: localDay });
      const done = item("done", { status: "done", completed_at: before });
      const timed = item("timed", { time_at: after });
      expect(band(scheduled, new Map(), Date.parse(before), zone)).toBe(
        "tomorrow",
      );
      expect(band(scheduled, new Map(), Date.parse(after), zone)).toBe("today");
      expect(band(timed, new Map(), Date.parse(before), zone)).toBe("tomorrow");
      expect(band(timed, new Map(), Date.parse(after), zone)).toBe("today");
      expect(band(done, new Map(), Date.parse(before), zone)).toBe(
        "done-today",
      );
      expect(band(done, new Map(), Date.parse(after), zone)).toBeNull();
      expect(isGhost(done, Date.parse(after))).toBe(true);
      expect(firstDayOfBand("tomorrow", Date.parse(after), zone)).toBe(
        tomorrow,
      );
    },
  );

  it.each([
    ["today", now, utc, "2024-04-03"],
    ["tomorrow", now, utc, "2024-04-04"],
    ["this-week", now, utc, "2024-04-05"],
    ["later", now, utc, "2024-04-08"],
    ["backlog", now, utc, null],
    ["this-week", Date.parse("2024-04-05T12:00:00Z"), utc, "2024-04-07"],
    ["tomorrow", Date.parse("2024-04-06T12:00:00Z"), utc, "2024-04-07"],
    ["later", Date.parse("2024-04-06T12:00:00Z"), utc, "2024-04-08"],
    [
      "tomorrow",
      Date.parse("2024-04-01T06:59:59Z"),
      "America/Los_Angeles",
      "2024-04-01",
    ],
    [
      "later",
      Date.parse("2024-04-01T06:59:59Z"),
      "America/Los_Angeles",
      "2024-04-02",
    ],
  ] as const)(
    "round-trips a %s drop at %s in %s",
    (target, time, zone, expected) => {
      const scheduled_on = firstDayOfBand(target, time, zone);
      expect(scheduled_on).toBe(expected);
      expect(
        band(item("dropped", { scheduled_on }), new Map(), time, zone),
      ).toBe(target);
    },
  );

  it.each([
    ["this-week", Date.parse("2024-04-06T12:00:00Z"), utc],
    ["this-week", Date.parse("2024-04-01T06:59:59Z"), "America/Los_Angeles"],
    ["done-today", now, utc],
  ] as const)(
    "has no schedulable date for %s at %s in %s",
    (target, time, zone) => {
      expect(firstDayOfBand(target, time, zone)).toBeNull();
    },
  );
});

describe("activity and attention", () => {
  it.each([
    ["active", "2024-04-03T11:45:00.000Z", true, false],
    ["active", "2024-04-03T11:44:59.999Z", false, true],
    ["active", "2024-04-03 11:50:00", true, false],
    ["active", "2024-04-03T12:00:00.001Z", false, false],
    ["active", null, false, true],
    ["queued", "2024-04-03T11:50:00Z", false, false],
    ["blocked", "2024-04-03T11:00:00Z", false, false],
  ] as const)(
    "%s with heartbeat %s",
    (status, last_heartbeat_at, live, stale) => {
      const work = item("item", { status, last_heartbeat_at });
      expect(isLive(work, now)).toBe(live);
      expect(isStale(work, now)).toBe(stale);
      expect(needsMe(work, now)).toBe(stale);
      expect(needsMe({ ...work, handoff: 1 }, now)).toBe(true);
    },
  );

  it("counts each item once and each live agent name once", () => {
    const live = {
      status: "active",
      last_heartbeat_at: "2024-04-03T12:00:00Z",
    } as const;
    const items = [
      item("a", { ...live, agent_name: "agent", handoff: 1 }),
      item("b", { ...live, agent_name: "agent" }),
      item("c", { ...live, agent_name: "another agent" }),
      item("d", live),
      item("e", { status: "active", agent_name: "stale agent", handoff: 1 }),
      item("f", { handoff: 1 }),
    ];
    expect(needsMeCount(items, now)).toBe(3);
    expect(agentsLive(items, now)).toEqual(["agent", "another agent"]);
  });

  it.each([
    ["done", "2024-04-02T12:00:00.001Z", true],
    ["done", "2024-04-02T12:00:00Z", false],
    ["done", "2024-04-03T12:00:00.001Z", false],
    ["done", null, false],
    ["queued", "2024-04-03T11:00:00Z", false],
  ] as const)(
    "checks the ghost window for %s at %s",
    (status, completed_at, expected) => {
      expect(isGhost(item("item", { status, completed_at }), now)).toBe(
        expected,
      );
    },
  );

  it.each([
    ["queued", "queued", true],
    ["queued", "cancelled", true],
    ["queued", "done", false],
    ["blocked", "done", true],
  ] as const)("%s with a %s blocker", (status, blockerStatus, expected) => {
    const work = item("work", { status });
    const blocker = item("blocker", { status: blockerStatus });
    const deps = [{ item_id: work.id, blocked_by_id: blocker.id }];
    expect(isBlocked(work, index([work, blocker]), deps)).toBe(expected);
    expect(isBlocked(blocker, index([work, blocker]), deps)).toBe(false);
  });

  const goal = item("goal", { handoff: 1 });
  const child = item("child", { parent_id: goal.id });
  const blocker = item("blocker");
  const nesting = { parent_id: child.id };
  const descendants = [
    item("handoff", { ...nesting, handoff: 1 }),
    item("stale", { ...nesting, status: "active" }),
    item("reopened", { ...nesting, reopen_count: 1 }),
    item("blocked", nesting),
    item("live", {
      ...nesting,
      status: "active",
      last_heartbeat_at: "2024-04-03T11:59:00Z",
    }),
  ];
  it.each(["handoff", "stale", "reopened", "blocked", "live", null] as const)(
    "rolls up %s as the most urgent descendant state",
    (ring) => {
      const visible =
        ring === null
          ? []
          : descendants.slice(descendants.findIndex(({ id }) => id === ring));
      const finished = item("finished", {
        ...nesting,
        status: "done",
        reopen_count: 1,
      });
      expect(
        rollUpRing(
          goal,
          [goal, child, blocker, finished, ...visible],
          [{ item_id: "blocked", blocked_by_id: blocker.id }],
          now,
        ),
      ).toBe(ring);
    },
  );

  it("retains progress after the completed child leaves the ghost window", () => {
    const done = item("done", {
      parent_id: goal.id,
      status: "done",
      completed_at: "2024-04-03T11:00:00Z",
    });
    const items = [
      goal,
      child,
      done,
      item("cancelled", { parent_id: goal.id, status: "cancelled" }),
      ...descendants,
    ];
    for (const [at, ghost] of [
      [now, true],
      [Date.parse("2024-04-04T12:00:00Z"), false],
    ] as const) {
      expect(isGhost(done, at)).toBe(ghost);
      expect(progress(goal, items)).toEqual({ done: 1, total: 2 });
    }
    expect(progress(blocker, items)).toEqual({ done: 0, total: 0 });
  });
});

describe("stream", () => {
  it("orders fixed times by instant, then sort keys, then descending priority", () => {
    const items = [
      item("low", { priority: 1 }),
      item("deadline", {
        priority: 10,
        time_type: "deadline",
        time_at: "2024-04-03T08:00:00Z",
      }),
      item("manual-later", { sort_key: 2 }),
      item("fixed-later", {
        time_type: "fixed",
        time_at: "2024-04-03T09:00:00Z",
        sort_key: -1,
      }),
      item("fixed-earlier", {
        time_type: "fixed",
        time_at: "2024-04-03T10:30:00+02:00",
      }),
      item("manual-first", { sort_key: 0 }),
      item("same-priority", { priority: 1 }),
    ];
    expect(streamOrder(items).map(({ id }) => id)).toEqual([
      "fixed-earlier",
      "fixed-later",
      "manual-first",
      "manual-later",
      "deadline",
      "low",
      "same-priority",
    ]);
    expect(items[0].id).toBe("low");
  });

  it("nests same-band children and promotes different-band children once", () => {
    const goal = item("goal", { scheduled_on: "2024-04-03" });
    const child = item("child", { parent_id: goal.id });
    const tomorrow = item("tomorrow", {
      parent_id: goal.id,
      scheduled_on: "2024-04-04",
    });
    const history = item("history", {
      status: "done",
      completed_at: "2024-04-02T20:00:00Z",
    });
    const high = item("high", { parent_id: child.id, priority: 10 });
    const low = item("low", { parent_id: child.id, priority: 1 });
    const orphan = item("orphan", { parent_id: history.id });
    const rows = streamRows(
      [low, child, goal, high, tomorrow, history, orphan],
      now,
      utc,
    );
    expect(rows.today).toEqual([
      {
        item: goal,
        children: [
          {
            item: child,
            children: [
              { item: high, children: [] },
              { item: low, children: [] },
            ],
          },
        ],
      },
    ]);
    expect(rows.tomorrow).toEqual([{ item: tomorrow, children: [] }]);
    expect(rows.backlog).toEqual([{ item: orphan, children: [] }]);
    expect(rows["done-today"]).toEqual([]);
  });

  it("omits a hidden top-level item and descendants across bands", () => {
    const goal = item("hidden goal", {
      hidden: 1,
      scheduled_on: "2024-04-03",
    });
    const child = item("same band", { parent_id: goal.id, depth: 2 });
    const tomorrow = item("different band", {
      parent_id: goal.id,
      depth: 2,
      scheduled_on: "2024-04-04",
    });
    const grandchild = item("grandchild", {
      parent_id: child.id,
      depth: 3,
      scheduled_on: "2024-04-05",
    });
    const visible = item("visible goal", { scheduled_on: "2024-04-03" });
    const items = [grandchild, child, tomorrow, goal, visible];

    expect(band(child, index(items), now, utc)).toBe("today");
    expect(Object.values(streamRows(items, now, utc)).flat()).toEqual([
      { item: visible, children: [] },
    ]);
  });
});
