import { forceCollide, forceSimulation, forceX, forceY } from "d3-force";
import { packSiblings } from "d3-hierarchy";
import { firstDayOfBand } from "../shared/derived-state";
import type { RadarBand } from "../shared/workspace";

export const WIDTH = 800;
export const HEIGHT = 760;
export const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };
export const RADAR_BANDS = ["today", "this-week", "later", "backlog"] as const;
export const RADAR_LABELS: Record<RadarBand, string> = {
  today: "Today",
  "this-week": "This week",
  later: "Later",
  backlog: "Backlog",
};

const TAU = 2 * Math.PI;
const START = -Math.PI / 2;
const boundaries = [0, 108, 180, 252, 325];
export const RADAR_RADIUS = boundaries[4];
export const GOAL_RADIUS = 266;

export type Point = { x: number; y: number };
export type Position = { angle: number; radius: number };
export type Cell = { band: RadarBand; sector: number; sectors: number };
export type RadarPlacement = {
  position: Position;
  scheduled_on?: string | null;
  project?: string;
};
type LayoutItem = {
  id: string;
  priority: number;
  position?: Position;
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));
const unitAngle = (angle: number) => ((angle - START + TAU) % TAU) / TAU;

export function polar(angle: number, radius: number): Point {
  return {
    x: CENTER.x + radius * Math.cos(angle),
    y: CENTER.y + radius * Math.sin(angle),
  };
}

export function cellBounds({ band, sector, sectors }: Cell) {
  const index = RADAR_BANDS.indexOf(band);
  const span = TAU / sectors;
  return {
    inner: boundaries[index],
    outer: boundaries[index + 1],
    start: START + sector * span,
    span,
  };
}

export function cellPoint(cell: Cell, position: Position): Point {
  const { inner, outer, start, span } = cellBounds(cell);
  return polar(
    start + span * clamp(position.angle),
    inner + (outer - inner) * clamp(position.radius),
  );
}

export function cellPosition(cell: Cell, point: Point): Position {
  const { inner, outer } = cellBounds(cell);
  const x = point.x - CENTER.x;
  const y = point.y - CENTER.y;
  const angle = unitAngle(Math.atan2(y, x)) * cell.sectors - cell.sector;
  // Choose the equivalent fraction nearest this sector when outside it.
  const wrapped =
    angle + Math.round((0.5 - angle) / cell.sectors) * cell.sectors;
  return {
    angle: clamp(angle >= 0 && angle <= 1 ? angle : wrapped),
    radius: clamp((Math.hypot(x, y) - inner) / (outer - inner)),
  };
}

export function targetCell(point: Point, sectors: number): Cell | null {
  const x = point.x - CENTER.x;
  const y = point.y - CENTER.y;
  const radius = Math.hypot(x, y);
  const index = RADAR_BANDS.findIndex(
    (_, index) => radius <= boundaries[index + 1],
  );
  if (index < 0 || sectors < 1) return null;
  return {
    band: RADAR_BANDS[index],
    sector: Math.floor(unitAngle(Math.atan2(y, x)) * sectors),
    sectors,
  };
}

export function scheduleForRing(
  band: RadarBand,
  now: number,
  timezone: string,
) {
  return firstDayOfBand(
    band === "this-week" ? "tomorrow" : band,
    now,
    timezone,
  );
}

export function radarDrop(
  point: Point,
  projects: readonly string[],
  source: { band: RadarBand; project: string; topLevel: boolean },
  now: number,
  timezone: string,
): RadarPlacement | null {
  const cell = targetCell(point, projects.length);
  if (!cell) return null;
  const project = projects[cell.sector];
  if (!source.topLevel && project !== source.project) return null;
  return {
    position: cellPosition(cell, point),
    scheduled_on:
      cell.band === source.band
        ? undefined
        : scheduleForRing(cell.band, now, timezone),
    project: project === source.project ? undefined : project,
  };
}

export const bubbleRadius = (priority: number) => 15 + 1.9 * priority;
export const priorityForRadius = (radius: number) =>
  clamp(Math.round((radius - 15) / 1.9), 1, 10);

function hash(value: string) {
  let result = 2166136261;
  for (const char of value)
    result = Math.imul(result ^ char.codePointAt(0)!, 16777619);
  return (result >>> 0) / 2 ** 32;
}

export function seedPosition(id: string): Position {
  return { angle: hash(id + ":angle"), radius: hash(id + ":radius") };
}

export function readRadarPosition(
  layout: string,
  id: string,
  key = "radar",
): Position | undefined {
  const position = JSON.parse(layout)?.[key] as Partial<Position> | undefined;
  const angle = Number.isFinite(position?.angle) ? position?.angle : undefined;
  const radius = Number.isFinite(position?.radius)
    ? position?.radius
    : undefined;
  if (angle === undefined && radius === undefined) return undefined;
  const seed = seedPosition(id);
  return {
    angle: clamp(angle ?? seed.angle),
    radius: clamp(radius ?? seed.radius),
  };
}

export function layoutRadar(items: readonly (LayoutItem & { cell: Cell })[]) {
  const groups = new Map<string, (typeof items)[number][]>();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${item.cell.band}:${item.cell.sector}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  const result = new Map<string, { position: Position; scale: number }>();
  let scale = 1;
  for (const group of groups.values()) {
    const { inner, outer, span } = cellBounds(group[0].cell);
    const area = ((outer ** 2 - inner ** 2) * span) / 2;
    const occupied = group.reduce(
      (sum, item) => sum + Math.PI * (bubbleRadius(item.priority) + 5) ** 2,
      0,
    );
    scale = Math.min(
      scale,
      clamp(Math.sqrt((0.55 * area) / occupied), 0.13, 1),
    );
  }
  for (const group of groups.values()) {
    const { cell } = group[0];
    const { inner, outer, span } = cellBounds(cell);
    const nodes = group.map((item) => {
      const point = cellPoint(cell, item.position ?? seedPosition(item.id));
      const radius = bubbleRadius(item.priority) * scale + 4;
      return {
        id: item.id,
        ...point,
        radius,
        target: point,
        manual: item.position,
        fx: item.position ? point.x : undefined,
        fy: item.position ? point.y : undefined,
      };
    });
    const simulation = forceSimulation(nodes)
      .stop()
      .force(
        "collision",
        forceCollide<(typeof nodes)[number]>((node) => node.radius).iterations(
          2,
        ),
      )
      .force(
        "angle",
        forceX<(typeof nodes)[number]>((node) => node.target.x).strength(0.035),
      )
      .force(
        "radius",
        forceY<(typeof nodes)[number]>((node) => node.target.y).strength(0.035),
      );
    for (let step = 0; step < 50; step++) {
      simulation.tick();
      for (const node of nodes) {
        if (node.manual) continue;
        const position = cellPosition(cell, node);
        const width = outer - inner;
        const outerPadding = Math.min(0.48, node.radius / width);
        const innerPadding =
          inner === 0
            ? Math.min(1 - outerPadding, (node.radius + 19) / width)
            : outerPadding;
        position.radius = clamp(
          position.radius,
          innerPadding,
          1 - outerPadding,
        );
        const distance = inner + (outer - inner) * position.radius;
        const anglePadding =
          cell.sectors === 1
            ? 0
            : Math.min(0.48, Math.asin(clamp(node.radius / distance)) / span);
        position.angle = clamp(position.angle, anglePadding, 1 - anglePadding);
        Object.assign(node, cellPoint(cell, position));
      }
    }
    for (const node of nodes) {
      result.set(node.id, {
        position: node.manual ?? cellPosition(cell, node),
        scale,
      });
    }
  }
  return result;
}

export function goalPosition(point: Point, radius: number): Position {
  const x = point.x - CENTER.x;
  const y = point.y - CENTER.y;
  return {
    angle: unitAngle(Math.atan2(y, x)),
    radius: clamp(Math.hypot(x, y) / (GOAL_RADIUS - radius)),
  };
}

export function goalPoint(position: Position, radius: number): Point {
  return polar(
    START + position.angle * TAU,
    position.radius * (GOAL_RADIUS - radius),
  );
}

export function layoutGoal(items: readonly LayoutItem[]) {
  const nodes = packSiblings(
    [...items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, priority }) => ({
        id,
        r: bubbleRadius(priority) + 8,
        x: 0,
        y: 0,
      })),
  );
  const extent = Math.max(
    1,
    ...nodes.map(({ x, y, r }) => Math.hypot(x, y) + r),
  );
  const scale = Math.min(2.2, (GOAL_RADIUS - 30) / extent);
  return new Map(
    nodes.map(({ id, x, y }) => [
      id,
      {
        point: { x: CENTER.x + x * scale, y: CENTER.y + y * scale },
        scale,
      },
    ]),
  );
}

export function truncateLabel(label: string, width: number, fontSize: number) {
  const budget = width / fontSize;
  const chars = Array.from(label, (char) => ({
    char,
    size: /[MW@%]/u.test(char)
      ? 0.95
      : /[il .,'!]/u.test(char)
        ? 0.32
        : char.codePointAt(0)! > 0x024f
          ? 1.05
          : 0.61,
  }));
  if (chars.reduce((sum, { size }) => sum + size, 0) <= budget) return label;
  let left = budget - 0.9;
  let text = "";
  for (const { char, size } of chars) {
    left -= size;
    if (left < 0) break;
    text += char;
  }
  return text.trimEnd() + "…";
}
