import {
  hierarchy,
  treemap,
  treemapSquarify,
  type HierarchyNode,
  type HierarchyRectangularNode,
} from "d3-hierarchy";
import type { StreamRow } from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import type { Project } from "@heedwork/core";

type NodeData = {
  key: string;
  title: string;
  children: NodeData[];
} & (
  | { kind: "workspace" }
  | { kind: "project"; project: Project }
  | { kind: "item"; item: CanvasItem }
);

export type TreemapNode = HierarchyNode<NodeData>;
export type TreemapRect = HierarchyRectangularNode<NodeData>;
type ItemNode = Extract<NodeData, { kind: "item" }>;

export function buildTreemap(
  projects: readonly Project[],
  tree: readonly StreamRow<CanvasItem>[],
  showGhosts: boolean,
): TreemapNode {
  function itemNodes(rows: readonly StreamRow<CanvasItem>[]): ItemNode[] {
    return rows
      .flatMap<ItemNode>(({ item, children }) => {
        // As in Radar, open descendants stay visible when a ghost is hidden.
        const descendants = itemNodes(children);
        if (!showGhosts && item.status === "done") return descendants;
        return [
          {
            kind: "item",
            key: `item:${item.id}`,
            title: item.title,
            item,
            children: descendants,
          },
        ];
      })
      .sort(
        (a, b) =>
          (a.item.sort_key ?? Infinity) - (b.item.sort_key ?? Infinity) ||
          a.item.id.localeCompare(b.item.id),
      );
  }

  const byProject = new Map<string, StreamRow<CanvasItem>[]>();
  for (const row of tree) {
    const rows = byProject.get(row.item.project_id);
    if (rows) rows.push(row);
    else byProject.set(row.item.project_id, [row]);
  }
  return hierarchy<NodeData>({
    kind: "workspace",
    key: "workspace",
    title: "All projects",
    children: [...projects]
      .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
      .flatMap((project) => {
        if (project.hidden) return [];
        const children = itemNodes(byProject.get(project.id) ?? []);
        if (!children.length) return [];
        return [
          {
            kind: "project",
            key: `project:${project.id}`,
            title: project.name,
            project,
            children,
          } satisfies NodeData,
        ];
      }),
  });
}

export function resolveTreemapFocus(
  root: TreemapNode,
  path: readonly string[],
  selectedId: string | null,
) {
  const selection =
    selectedId && root.find(({ data }) => data.key === `item:${selectedId}`);
  const ancestors = selection ? new Set(selection.ancestors()) : null;
  let focused = root;
  for (const key of path) {
    const next = focused.children?.find(({ data }) => data.key === key);
    if (!next?.children || (ancestors && !ancestors.has(next))) break;
    focused = next;
  }
  return focused;
}

export function treemapHeaderHeight(kind: NodeData["kind"], height: number) {
  return Math.min(kind === "project" ? 32 : 40, height / 2);
}

function weight(data: NodeData): number {
  if (data.kind === "item") return data.item.priority;
  return data.children.reduce((total, child) => total + weight(child), 0);
}

export function layoutTreemap(
  focus: TreemapNode,
  width: number,
  height: number,
) {
  const leaves = new Map<NodeData, number>();
  function distribute(node: NodeData, budget: number) {
    if (!node.children.length) {
      leaves.set(node, budget);
      return;
    }
    // Use the parent's priority as its area budget, then divide it among
    // its children. D3 sums the resulting leaf areas back up the hierarchy.
    const weights = node.children.map(weight);
    const total = weights.reduce((sum, value) => sum + value, 0);
    node.children.forEach((child, index) =>
      distribute(child, budget * (weights[index] / total)),
    );
  }
  distribute(focus.data, weight(focus.data));
  const root = focus.copy().sum((node) => leaves.get(node) ?? 0);
  return treemap<NodeData>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingLeft((node) =>
      node.depth ? Math.min(4, (node.x1 - node.x0) / 10) : 0,
    )
    .paddingRight((node) =>
      node.depth ? Math.min(4, (node.x1 - node.x0) / 10) : 0,
    )
    .paddingBottom((node) =>
      node.depth ? Math.min(6, (node.y1 - node.y0) / 10) : 0,
    )
    .paddingTop((node) =>
      node.depth ? treemapHeaderHeight(node.data.kind, node.y1 - node.y0) : 0,
    )(root);
}
