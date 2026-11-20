import { expect, it } from "vitest";
import {
  bubbleRadius,
  cellPoint,
  cellPosition,
  layoutGoal,
  layoutRadar,
  polar,
  priorityForRadius,
  RADAR_BANDS,
  radarDrop,
  readRadarPosition,
  seedPosition,
  targetCell,
  type Cell,
} from "./radar-geometry";
import { now } from "./workspace-fixtures";

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
  expect(drop("later")).toMatchObject({ scheduled_on: "2024-04-08" });
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
  const result = layoutRadar(nodes);
  expect(layoutRadar([...nodes].reverse())).toEqual(result);
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
