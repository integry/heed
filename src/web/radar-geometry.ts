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
const boundaries = [0, 103, 177, 251, 325];
export const RADAR_RADIUS = boundaries[4];
export const GOAL_RADIUS = 266;
export const RADAR_LABEL_FONT = 11;
export const MIN_FIELD_SCALE = 0.35;

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
): (RadarPlacement & { band: RadarBand }) | null {
  const cell = targetCell(point, projects.length);
  if (!cell) return null;
  const project = projects[cell.sector];
  if (!source.topLevel && project !== source.project) return null;
  return {
    band: cell.band,
    position: cellPosition(cell, point),
    scheduled_on:
      cell.band === source.band
        ? undefined
        : scheduleForRing(cell.band, now, timezone),
    project: project === source.project ? undefined : project,
  };
}

const MIN_RADIUS = 12;
const RADIUS_STEP = (36 - MIN_RADIUS) / 9;
export const bubbleRadius = (priority: number) =>
  MIN_RADIUS + RADIUS_STEP * (priority - 1);
export const priorityForRadius = (radius: number) =>
  clamp(Math.round((radius - MIN_RADIUS) / RADIUS_STEP) + 1, 1, 10);

export function radarViewport(width: number, height: number, goal: boolean) {
  const side = Math.min(width, height);
  const padding = Math.min(25, side / 8);
  const scale = goal
    ? Math.min(width / WIDTH, height / HEIGHT)
    : (side - 2 * padding) / (2 * RADAR_RADIUS);
  const sceneWidth = width / scale;
  const sceneHeight = height / scale;
  return {
    scale,
    x: CENTER.x - sceneWidth / 2,
    y: CENTER.y - sceneHeight / 2,
    width: sceneWidth,
    height: sceneHeight,
  };
}

const ringLabels = RADAR_BANDS.map((band) => {
  const { inner, outer } = cellBounds({ band, sector: 0, sectors: 1 });
  const text = band === "today" ? "Today · You" : RADAR_LABELS[band];
  return {
    text,
    point: band === "today" ? CENTER : polar(START, (inner + outer) / 2),
    halfWidth: labelWidth(text, RADAR_LABEL_FONT) / 2 + 5,
    halfHeight: RADAR_LABEL_FONT / 2 + 5,
  };
});

export function ringLabel(band: RadarBand) {
  return ringLabels[RADAR_BANDS.indexOf(band)];
}

function ringLabelClearance(point: Point, scale: number) {
  if (scale === Infinity) return Infinity;
  return Math.min(
    ...ringLabels.map((label) =>
      Math.hypot(
        Math.max(
          0,
          Math.abs(point.x - label.point.x) - label.halfWidth / scale,
        ),
        Math.max(
          0,
          Math.abs(point.y - label.point.y) - label.halfHeight / scale,
        ),
      ),
    ),
  );
}

export function overlapsRingLabel(point: Point, radius: number, scale: number) {
  return ringLabelClearance(point, scale) < radius;
}

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

export function layoutRadar(
  items: readonly (LayoutItem & { cell: Cell })[],
  fitScale = 1,
) {
  // Keep the spoke clear at the overview's minimum zoom as well as at Fit.
  const labelScale = fitScale >= MIN_FIELD_SCALE ? fitScale * 0.65 : Infinity;
  const groups = new Map<string, (typeof items)[number][]>();
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${item.cell.band}:${item.cell.sector}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const result = new Map<string, { position: Position; scale: number }>();
  for (const group of groups.values()) {
    const { cell } = group[0];
    const { inner, outer, start, span } = cellBounds(cell);
    function clearance(point: Point, angle: number, distance: number) {
      const sectorEdge =
        cell.sectors === 1
          ? Infinity
          : distance *
            Math.min(Math.sin(span * angle), Math.sin(span * (1 - angle)));
      return Math.min(
        distance - inner,
        outer - distance,
        sectorEdge,
        ringLabelClearance(point, labelScale),
      );
    }
    const area = ((outer ** 2 - inner ** 2) * span) / 2;
    const step = Math.min(5, Math.sqrt(area / (12 * group.length)));
    const radialSteps = Math.ceil((outer - inner) / step);
    const candidates: { point: Point; position: Position; space: number }[] =
      [];
    for (let row = 0; row < radialSteps; row++) {
      const radius = (row + 0.5) / radialSteps;
      const distance = inner + radius * (outer - inner);
      const angularSteps = Math.ceil((distance * span) / step);
      for (let column = 0; column < angularSteps; column++) {
        const angle = (column + 0.5) / angularSteps;
        const point = polar(start + angle * span, distance);
        const space = clearance(point, angle, distance);
        if (space > 0)
          candidates.push({ position: { angle, radius }, point, space });
      }
    }

    const ordered = group
      .map((item) => {
        const position = item.position ?? seedPosition(item.id);
        const point = cellPoint(cell, position);
        const space = clearance(
          point,
          position.angle,
          inner + position.radius * (outer - inner),
        );
        return { ...item, preferred: { position, point, space } };
      })
      .sort(
        (a, b) =>
          Number(Boolean(b.position)) - Number(Boolean(a.position)) ||
          b.priority - a.priority ||
          a.id.localeCompare(b.id),
      );

    // Pack into each cell independently so crowding cannot shrink other cells.
    // Try stored positions first, then use the nearest available slot.
    let initialScale = 1;
    for (const item of ordered) {
      if (!item.position) continue;
      const scale = (item.preferred.space - 2) / bubbleRadius(item.priority);
      // A drop very near a boundary may shift inward to stay readable.
      if (scale >= 0.5) initialScale = Math.min(scale, initialScale);
    }
    for (let scale = initialScale; scale >= 0.015; scale *= 0.88) {
      const placed: { point: Point; radius: number; position: Position }[] = [];
      for (const item of ordered) {
        const radius =
          bubbleRadius(item.priority) * scale + Math.min(2, scale * 8);
        function fits({ point, space }: (typeof candidates)[number]) {
          return (
            space + 1e-9 >= radius &&
            placed.every(
              (other) =>
                Math.hypot(point.x - other.point.x, point.y - other.point.y) >=
                radius + other.radius,
            )
          );
        }

        let slot = fits(item.preferred) ? item.preferred : undefined;
        if (!slot) {
          let nearest = Infinity;
          for (const candidate of candidates) {
            const delta =
              (candidate.point.x - item.preferred.point.x) ** 2 +
              (candidate.point.y - item.preferred.point.y) ** 2;
            if (delta < nearest && fits(candidate)) {
              nearest = delta;
              slot = candidate;
            }
          }
        }
        if (!slot) break;
        placed.push({ ...slot, radius });
      }
      if (placed.length === ordered.length) {
        ordered.forEach(({ id }, index) => {
          result.set(id, { position: placed[index].position, scale });
        });
        break;
      }
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

function charWidth(char: string) {
  return /[MW@%]/u.test(char)
    ? 1.05
    : /[il .,'!]/u.test(char)
      ? 0.34
      : char.codePointAt(0)! > 0x024f
        ? 1.1
        : 0.65;
}

export function labelWidth(label: string, fontSize: number) {
  return (
    Array.from(label).reduce((sum, char) => sum + charWidth(char), 0) * fontSize
  );
}

export function truncateLabel(label: string, width: number, fontSize: number) {
  if (labelWidth(label, fontSize) <= width) return label;
  let left = width / fontSize - charWidth("…");
  let text = "";
  for (const char of label) {
    left -= charWidth(char);
    if (left < 0) break;
    text += char;
  }
  return text.trimEnd() + "…";
}
