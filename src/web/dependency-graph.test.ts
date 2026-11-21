import { expect, it } from "vitest";
import type { CanvasItem } from "../shared/workspace-socket";
import {
  blockerCounts,
  layoutDependencies,
  scopeDependencies,
} from "./dependency-graph";
import { child, goal, tomorrow } from "./workspace-fixtures";

function itemMap(...items: CanvasItem[]) {
  return new Map(items.map((item) => [item.id, item]));
}

function edge(blocked_by_id: string, item_id: string) {
  return { item_id, blocked_by_id };
}

it("includes nested descendants and direct external neighbors in both directions", () => {
  const nested = { ...child, id: "nested", parent_id: child.id, depth: 3 };
  const upstream = { ...goal, id: "upstream" };
  const downstream = { ...goal, id: "downstream" };
  const unrelated = { ...goal, id: "unrelated" };
  const hidden = { ...goal, id: "hidden", hidden: 1 as const };
  const outsideEdges = [
    edge(upstream.id, nested.id),
    edge(child.id, downstream.id),
  ];
  const items = itemMap(
    goal,
    child,
    nested,
    upstream,
    downstream,
    unrelated,
    hidden,
  );
  const visible = itemMap(goal, child, nested, upstream, downstream, unrelated);
  const scoped = scopeDependencies(goal.id, items, visible, [
    ...outsideEdges,
    edge(unrelated.id, upstream.id),
    edge(upstream.id, downstream.id),
    edge(hidden.id, child.id),
    edge(child.id, "archived"),
  ]);

  expect(scoped.descendants).toEqual(new Set([child.id, nested.id]));
  expect(new Set(scoped.nodes.keys())).toEqual(
    new Set([child.id, nested.id, upstream.id, downstream.id]),
  );
  expect(scoped.edges).toEqual(outsideEdges);
});

it("uses the longest path for layers and reserves waypoints for edges that skip layers", () => {
  const complete = { ...child, id: "complete", status: "done" as const };
  const nodes = itemMap(goal, child, tomorrow, complete);
  const shortcut = edge(complete.id, tomorrow.id);
  const layout = layoutDependencies(nodes, [
    edge(complete.id, goal.id),
    edge(goal.id, child.id),
    edge(child.id, tomorrow.id),
    shortcut,
  ]);

  expect(
    [complete.id, goal.id, child.id, tomorrow.id].map(
      (id) => layout.positions.get(id)?.layer,
    ),
  ).toEqual([0, 1, 2, 3]);
  const route = layout.routes.find(({ edge }) => edge === shortcut)!;
  expect(route.waypoints.map(({ layer }) => layer)).toEqual([0, 1, 2, 3]);
  expect(route.waypoints[1].y).not.toBe(layout.positions.get(goal.id)?.y);
  expect(route.waypoints[2].y).not.toBe(layout.positions.get(child.id)?.y);
});

it("aligns connected pairs across layers to reduce crossings", () => {
  const nodes = itemMap(
    ...["A", "B", "C", "D"].map((id) => ({ ...child, id, title: id })),
  );
  const { positions } = layoutDependencies(nodes, [
    edge("A", "D"),
    edge("B", "C"),
  ]);

  expect(positions.get("D")?.y).toBe(positions.get("A")?.y);
  expect(positions.get("C")?.y).toBe(positions.get("B")?.y);
});

it("counts each unfinished downstream item once and stops at completed work", () => {
  const nodes = itemMap(
    ...["source", "left", "right", "shared", "queued"].map((id) => ({
      ...child,
      id,
    })),
    { ...child, id: "done", status: "done" },
  );
  const counts = blockerCounts(nodes, [
    edge("source", "left"),
    edge("source", "right"),
    edge("left", "shared"),
    edge("right", "shared"),
    edge("source", "done"),
    edge("done", "queued"),
  ]);

  expect(counts).toEqual(
    new Map([
      ["source", 3],
      ["left", 1],
      ["right", 1],
    ]),
  );
});
