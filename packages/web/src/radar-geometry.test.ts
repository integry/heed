import { expect, it } from "vitest";
import { demoGoal, demoProjects, radarDemoItems } from "./radar-test-data.mjs";
import { radarBandsFor } from "@heedwork/core";
import {
  bubbleRadius,
  cellPoint,
  cellPosition,
  CENTER,
  layoutGoal,
  layoutRadar,
  polar,
  overlapsRingLabel,
  priorityForRadius,
  RADAR_BANDS,
  RADAR_RADIUS,
  radarDrop,
  radarViewport,
  readRadarPosition,
  seedPosition,
  targetCell,
  type Cell,
} from "./radar-geometry";
import { outsideLabels, radarTimeBadge, titleLines } from "./radar-labels";
import { goal, now } from "./workspace-fixtures";

it("keeps stored fractions when an existing radar position has only one coordinate", () => {
  expect(readRadarPosition('{"radar":{"radius":0.5}}', "goal")).toEqual({
    angle: seedPosition("goal").angle,
    radius: 0.5,
  });
  expect(readRadarPosition("{}", "goal")).toBeUndefined();
});

it("round-trips polar cell positions through every ring and sector", () => {
  for (const band of RADAR_BANDS) {
    for (let sector = 0; sector < 4; sector++) {
      const cell = { band, sector, sectors: 4 };
      const point = cellPoint(cell, { angle: 0.35, radius: 0.68 });
      expect(targetCell(point, 4)).toEqual(cell);
      expect(cellPosition(cell, point).angle).toBeCloseTo(0.35);
      expect(cellPosition(cell, point).radius).toBeCloseTo(0.68);
    }
  }
  expect(targetCell(polar(0, 400), 4)).toBeNull();
});

it("maps drops to the first day of a ring in the workspace timezone and moves top-level projects", () => {
  const projects = ["inbox", "work"];
  const source = { band: "today", project: "inbox", topLevel: true } as const;
  const drop = (band: Cell["band"]) =>
    radarDrop(
      cellPoint({ band, sector: 1, sectors: 2 }, { angle: 0.3, radius: 0.5 }),
      projects,
      source,
      now,
      "Pacific/Honolulu",
    );
  expect(drop("today")).toMatchObject({
    scheduled_on: undefined,
    project: "work",
  });
  expect(drop("this-week")).toMatchObject({
    scheduled_on: "2024-04-04",
    project: "work",
  });
  expect(drop("later")).toMatchObject({
    band: "later",
    scheduled_on: "2024-04-08",
  });
  expect(drop("backlog")).toMatchObject({ scheduled_on: null });
  const point = cellPoint(
    { band: "today", sector: 1, sectors: 2 },
    { angle: 0.3, radius: 0.5 },
  );
  expect(
    radarDrop(point, projects, { ...source, topLevel: false }, now, "UTC"),
  ).toBeNull();
  expect(
    radarDrop(
      point,
      projects,
      { ...source, project: "work", topLevel: false },
      now,
      "UTC",
    ),
  ).toMatchObject({ scheduled_on: undefined, project: undefined });
});

it("resolves radii to a whole priority between 1 and 10", () => {
  for (let priority = 1; priority <= 10; priority++) {
    expect(priorityForRadius(bubbleRadius(priority))).toBe(priority);
  }
  expect(priorityForRadius(-30)).toBe(1);
  expect(priorityForRadius(200)).toBe(10);
});

it("places automatic bubbles deterministically in their cell and pins stored positions", () => {
  const cell: Cell = { band: "later", sector: 3, sectors: 4 };
  const position = { angle: 0.3, radius: 0.75 };
  const nodes = [
    { id: "fixed", cell, priority: 8, position },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `auto-${i}`,
      cell,
      priority: 5,
    })),
  ];
  const { placements: result } = layoutRadar(nodes);
  expect(layoutRadar([...nodes].reverse()).placements).toEqual(result);
  expect(result.get("fixed")?.position).toEqual(position);
  for (const placement of result.values()) {
    expect(targetCell(cellPoint(cell, placement.position), 4)).toEqual(cell);
  }
  expect(
    new Set(
      [...result.values()].map(({ position }) => JSON.stringify(position)),
    ).size,
  ).toBe(nodes.length);
  expect(layoutGoal(nodes)).toEqual(layoutGoal([...nodes].reverse()));
});

it.each([false, true])(
  "packs the radar demo at desktop and phone sizes (dense = %s)",
  (dense) => {
    const projectNames = {
      inbox: "Inbox",
      engineering: "Engineering",
      product: "Product",
      customer: "Customer Success",
    };
    const demo = [
      ["reliability", demoGoal] as const,
      ...radarDemoItems(dense, projectNames),
    ];
    const items = demo.map(
      ([id, [project, title, priority, ring, options]]) => ({
        ...goal,
        id: `radar-demo-${id}`,
        project_id: project,
        title,
        priority,
        scheduled_on: ["2024-04-03", "2024-04-04", "2024-04-17", null][ring],
        status: options?.status ?? ("queued" as const),
        time_type: options?.time_type ?? ("flexible" as const),
        time_at: options?.time ? `2024-04-03T${options.time}:00.000Z` : null,
      }),
    );
    const itemMap = new Map(items.map((item) => [item.id, item]));
    const bands = radarBandsFor(items, itemMap, now, "UTC");
    const nodes = items.map(({ id, project_id, priority }) => ({
      id,
      priority,
      cell: {
        band: bands.get(id)!,
        sectors: demoProjects.length,
        sector: demoProjects.indexOf(project_id),
      },
    }));
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    for (const [width, height] of [
      [800, 655],
      [360, 545],
      [390, 545],
      [410, 715],
    ]) {
      const { scale } = radarViewport(width, height, false);
      expect(2 * RADAR_RADIUS * scale).toBeCloseTo(
        Math.min(width, height) - 50,
      );
      const layout = layoutRadar(nodes, scale);
      expect(layout.placements.size).toBe(dense ? 300 : 17);
      expect(layout.visibleBands).toEqual(RADAR_BANDS);
      expect(layoutRadar([...nodes].reverse(), scale)).toEqual(layout);
      const bubbles = nodes.map(({ id, cell, priority }) => {
        const placement = layout.placements.get(id)!;
        const point = cellPoint(cell, placement.position);
        const radius = bubbleRadius(priority) * placement.scale;
        expect(targetCell(point, demoProjects.length)).toEqual(cell);
        expect(
          Math.hypot(point.x - CENTER.x, point.y - CENTER.y) + radius,
        ).toBeLessThanOrEqual(RADAR_RADIUS);
        expect(overlapsRingLabel(point, radius, scale * 0.65)).toBe(false);
        const item = itemMap.get(id)!;
        return {
          id,
          point,
          radius,
          title: item.title,
          ...radarTimeBadge(item, formatter),
        };
      });
      const callouts = outsideLabels(bubbles, scale, layout.visibleBands);
      expect(
        outsideLabels([...bubbles].reverse(), scale, layout.visibleBands),
      ).toEqual(callouts);
      if (!dense) expect(callouts.size).toBeGreaterThan(0);
      for (const [i, bubble] of bubbles.entries()) {
        for (const other of bubbles.slice(i + 1)) {
          if (
            Math.hypot(
              bubble.point.x - other.point.x,
              bubble.point.y - other.point.y,
            ) <
            bubble.radius + other.radius
          ) {
            throw Error(`${bubble.id} overlaps ${other.id} at ${width}px`);
          }
        }
      }
      for (const { x, y, halfWidth, halfHeight, lines } of callouts.values()) {
        expect(lines.length).toBeLessThanOrEqual(2);
        for (const { point, radius } of bubbles) {
          if (
            Math.hypot(
              Math.max(0, Math.abs(point.x - x) - halfWidth),
              Math.max(0, Math.abs(point.y - y) - halfHeight),
            ) < radius
          ) {
            throw Error(`Callout covers a bubble at ${width}px`);
          }
        }
      }
    }
  },
);

it("makes the largest priority three times the smallest", () => {
  expect(bubbleRadius(10)).toBe(3 * bubbleRadius(1));
});

it("packs colliding manual positions around the stored anchor", () => {
  const cell: Cell = { band: "later", sector: 1, sectors: 4 };
  const position = { angle: 0.45, radius: 0.5 };
  const { placements } = layoutRadar([
    { id: "a", priority: 10, cell, position },
    { id: "b", priority: 10, cell, position },
  ]);
  expect(placements.get("a")?.position).toEqual(position);
  expect(placements.get("b")?.position).not.toEqual(position);
});

it.each([
  [16, 280, ["today", "later", "backlog"]],
  [2048, 225, []],
] as const)(
  "packs colliding items in a narrow cell with %i projects",
  (sectors, height, expectedBands) => {
    const cell: Cell = { band: "this-week", sector: 0, sectors };
    const position = { angle: 0.5, radius: 0.5 };
    const items = ["a", "b"].map((id) => ({
      id,
      priority: 10,
      cell,
      position,
    }));
    const { scale } = radarViewport(360, height, false);
    const layout = layoutRadar(items, scale);
    expect(layoutRadar([...items].reverse(), scale)).toEqual(layout);
    expect(layout.visibleBands).toEqual(expectedBands);
    const [a, b] = items.map(({ id, priority }) => {
      const placement = layout.placements.get(id)!;
      const point = cellPoint(cell, placement.position);
      const radius = bubbleRadius(priority) * placement.scale;
      expect(radius).toBeGreaterThan(0);
      expect(targetCell(point, sectors)).toEqual(cell);
      expect(
        overlapsRingLabel(point, radius, scale * 0.65, layout.visibleBands),
      ).toBe(false);
      return { point, radius };
    });
    expect(
      Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y),
    ).toBeGreaterThanOrEqual(a.radius + b.radius);
  },
);

it("wraps titles to two lines before truncating", () => {
  expect(titleLines("Review payment reconciliation", 70, 11)).toEqual([
    "Review",
    "payment…",
  ]);
  expect(titleLines("Support templates", 50, 11)).toEqual(["Suppo…"]);
});

it("lets a bubble callout use space reserved only by a hidden ring label", () => {
  const item = {
    id: "a",
    title: "Review payment reconciliation",
    point: { x: 330, y: 240 },
    radius: 10,
    stamp: null,
    badge: null,
  };
  expect(outsideLabels([item], 1, RADAR_BANDS).get(item.id)!.x).toBeLessThan(
    item.point.x,
  );
  expect(
    outsideLabels([item], 1, ["today", "later", "backlog"]).get(item.id)!.x,
  ).toBeGreaterThan(item.point.x);
});

it("wraps a long title onto three lines in a large bubble", async () => {
  const { bubbleLabel, wrapLines } = await import("./radar-labels");
  expect(wrapLines("Plan the quarterly review", 75, 11, 3)).toEqual([
    "Plan the",
    "quarterly",
    "review",
  ]);
  const fitted = bubbleLabel("Plan the quarterly review", null, null, 36, 1);
  expect(fitted.lines.join(" ")).toBe("Plan the quarterly review");
});
