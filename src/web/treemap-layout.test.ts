import { expect, it } from "vitest";
import type { StreamRow } from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import {
  buildTreemap,
  layoutTreemap,
  resolveTreemapFocus,
  type TreemapRect,
} from "./treemap-layout";
import { child, goal, project, tomorrow } from "./workspace-fixtures";

const subtask = {
  ...child,
  id: "subtask",
  parent_id: child.id,
  depth: 3,
};
const otherProject = { ...project, id: "other", sort: 1 };
const otherGoal = { ...goal, id: "other-goal", project_id: otherProject.id };

function row(item: CanvasItem, ...children: StreamRow<CanvasItem>[]) {
  return { item, children };
}

it("groups visible work into project, goal, task and sub-task, promoting open work beneath hidden ghosts", () => {
  const ghost = { ...child, status: "done" } as const;
  const hidden = { ...otherProject, hidden: 1 } as const;
  const tree = [row(otherGoal), row(goal, row(ghost, row(subtask)))];
  const withGhosts = buildTreemap([hidden, project], tree, true);

  expect(
    withGhosts
      .leaves()[0]
      .ancestors()
      .map(({ data }) => data.key),
  ).toEqual([
    "item:subtask",
    "item:child",
    "item:goal",
    "project:inbox",
    "workspace",
  ]);
  expect(withGhosts.children).toHaveLength(1);
  const withoutGhosts = buildTreemap([hidden, project], tree, false);
  expect(withoutGhosts.leaves()[0].parent?.data.key).toBe("item:goal");
});

function area({ x0, x1, y0, y1 }: TreemapRect) {
  return (x1 - x0) * (y1 - y0);
}

it("allocates area by priority independently at each depth", () => {
  const smallGoal = { ...goal, id: "small-goal", priority: 2 };
  const bigGoal = { ...goal, priority: 6 };
  const tree = [
    row(
      bigGoal,
      row({ ...child, priority: 1 }, row(subtask)),
      row({ ...tomorrow, priority: 4 }),
    ),
    row(smallGoal),
    row({ ...otherGoal, priority: 4 }),
  ];
  const root = buildTreemap([project, otherProject], tree, true);
  const [inbox, other] = layoutTreemap(root, 640, 480).children!;
  const [big, small] = inbox.children!;
  const [a, b] = big.children!;

  expect(area(inbox) / area(other)).toBeCloseTo(2);
  expect(area(big) / area(small)).toBeCloseTo(3);
  expect(area(b) / area(a)).toBeCloseTo(4);
  expect(area(a.children![0])).toBeLessThan(area(a));
});

it("uses sort and ID order and keeps coordinates stable across unrelated updates", () => {
  const early = { ...tomorrow, sort_key: 1 };
  const late = { ...child, sort_key: 5 };
  const tied = { ...late, id: "aaa" };
  const sortedProject = {
    ...otherProject,
    sort: project.sort,
    name: "Aardvark",
  };
  function placements(rows: StreamRow<CanvasItem>[]) {
    const root = buildTreemap(
      [sortedProject, project],
      [row(otherGoal), row(goal, ...rows)],
      true,
    );
    return layoutTreemap(root, 640, 480)
      .descendants()
      .map(({ data, x0, y0, x1, y1 }) => [data.key, x0, y0, x1, y1]);
  }

  const before = placements([row(late), row(tied), row(early)]);
  expect(before.map(([key]) => key)).toEqual([
    "workspace",
    "project:inbox",
    "project:other",
    "item:goal",
    "item:other-goal",
    "item:tomorrow",
    "item:aaa",
    "item:child",
  ]);
  expect(
    placements([
      row(early),
      row(tied),
      row({ ...late, status: "blocked", title: "Changed", scheduled_on: null }),
    ]),
  ).toEqual(before);
});

it("keeps zoom for a selection within the scope and falls back to a visible ancestor", () => {
  const tree = [
    row(otherGoal),
    row(goal, row(child, row(subtask)), row(tomorrow)),
  ];
  const root = buildTreemap([project, otherProject], tree, true);
  const path = ["project:inbox", "item:goal", "item:child"];
  const focus = resolveTreemapFocus(root, path, subtask.id);
  expect(focus.data.key).toBe("item:child");
  expect(layoutTreemap(focus, 400, 300).children?.map(area)).toEqual([120_000]);
  expect(resolveTreemapFocus(root, path, tomorrow.id).data.key).toBe(
    "item:goal",
  );
  expect(resolveTreemapFocus(root, path, otherGoal.id)).toBe(root);

  const filtered = buildTreemap([project], [row(goal, row(tomorrow))], true);
  expect(resolveTreemapFocus(filtered, path, null).data.key).toBe("item:goal");
});
