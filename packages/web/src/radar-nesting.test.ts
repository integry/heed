import { expect, it } from "vitest";
import type { CanvasItem } from "@heedwork/core";
import { nestProblem, nestTarget, subtreeHeight } from "./radar-nesting";

function tree(...rows: [id: string, parent: string | null][]) {
  const items = new Map<string, CanvasItem>();
  for (const [id, parent] of rows) {
    const depth = parent === null ? 1 : items.get(parent)!.depth + 1;
    items.set(id, { id, parent_id: parent, depth } as CanvasItem);
  }
  return items;
}

const items = tree(
  ["goal", null],
  ["task", "goal"],
  ["step", "task"],
  ["other", null],
  ["pair", null],
  ["pair-child", "pair"],
);

it("measures how many levels sit below an item", () => {
  expect(subtreeHeight("goal", items)).toBe(2);
  expect(subtreeHeight("task", items)).toBe(1);
  expect(subtreeHeight("step", items)).toBe(0);
});

it("allows nesting within three levels and lifting to the top level", () => {
  expect(nestProblem(items.get("other")!, "task", items)).toBeNull();
  expect(nestProblem(items.get("pair")!, "other", items)).toBeNull();
  expect(nestProblem(items.get("step")!, null, items)).toBeNull();
  expect(nestProblem(items.get("task")!, "other", items)).toBeNull();
});

it("refuses cycles and a fourth level", () => {
  expect(nestProblem(items.get("goal")!, "step", items)).toMatch(/itself/);
  expect(nestProblem(items.get("goal")!, "goal", items)).toMatch(/itself/);
  expect(nestProblem(items.get("pair")!, "task", items)).toMatch(/3 levels/);
  expect(nestProblem(items.get("goal")!, "other", items)).toMatch(/3 levels/);
});

it("targets the smallest other bubble under the point", () => {
  const circle = (id: string, x: number, radius: number) => ({
    item: items.get(id)!,
    point: { x, y: 0 },
    radius,
  });
  const circles = [
    circle("goal", 0, 50),
    circle("other", 10, 20),
    circle("pair", 200, 20),
  ];
  expect(nestTarget({ x: 12, y: 0 }, circles, "pair")?.item.id).toBe("other");
  expect(nestTarget({ x: 12, y: 0 }, circles, "other")?.item.id).toBe("goal");
  expect(nestTarget({ x: 100, y: 0 }, circles, "pair")).toBeUndefined();
  // The rim of a bubble is not enough.
  expect(nestTarget({ x: 45, y: 0 }, circles, "pair")).toBeUndefined();
});
