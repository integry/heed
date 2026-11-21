import { workspaceInstant } from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import type { RadarBand } from "@heedwork/core";
import {
  CENTER,
  labelWidth,
  RADAR_LABEL_FONT,
  RADAR_RADIUS,
  ringLabel,
  truncateLabel,
  type Point,
} from "./radar-geometry";

export function titleLines(title: string, width: number, font: number) {
  if (labelWidth(title, font) <= width) return [title];
  let first = "";
  let rest = title;
  for (const word of title.split(/\s+/u)) {
    const next = first ? `${first} ${word}` : word;
    if (labelWidth(next, font) > width) break;
    first = next;
    rest = rest.trimStart().slice(word.length);
  }
  if (!first && !/\s/u.test(title)) {
    first = truncateLabel(title, width, font).slice(0, -1);
    rest = title.slice(first.length);
  }
  return first
    ? [first, truncateLabel(rest.trimStart(), width, font)]
    : [truncateLabel(title, width, font)];
}

export function bubbleLabel(
  title: string,
  stamp: string | null,
  badge: string | null,
  radius: number,
  scale: number,
) {
  const font = RADAR_LABEL_FONT / scale;
  const inset = Math.max(0, radius - 2 / scale);
  const chord = (height: number) =>
    2 * Math.sqrt(Math.max(0, inset ** 2 - height ** 2));
  const badgeY = inset >= 24 / scale ? 11 / scale : 0;
  const visibleBadge = [
    { text: stamp, padding: 6, height: 14 },
    { text: badge, padding: 2, height: 11 },
  ].flatMap(({ text, padding, height }) => {
    if (!text) return [];
    const width = labelWidth(text, font) + padding / scale;
    const badgeInset = radius - 0.75 / scale;
    if (Math.hypot(width / 2, badgeY + height / (2 * scale)) > badgeInset)
      return [];
    return [{ text, width, height: height / scale }];
  })[0];
  const labelY = visibleBadge ? -6 / scale : 0;
  const singleWidth = chord(Math.abs(labelY) + 6 / scale);
  const doubleWidth = chord(12 / scale);
  const lines =
    visibleBadge && badgeY === 0
      ? []
      : labelWidth(title, font) <= singleWidth
        ? [title]
        : !visibleBadge && doubleWidth >= 25 / scale
          ? titleLines(title, doubleWidth, font)
          : singleWidth >= 25 / scale
            ? [truncateLabel(title, singleWidth, font)]
            : [];
  return { labelY, lines, badgeY, visibleBadge, font };
}

export function radarTimeBadge(
  item: CanvasItem,
  timeFormatter: Intl.DateTimeFormat,
) {
  const time = workspaceInstant(item.time_at);
  const badge =
    item.time_type !== "flexible" && Number.isFinite(time)
      ? item.time_type === "fixed"
        ? "Fixed"
        : "Due"
      : null;
  const stamp = badge ? `${badge} ${timeFormatter.format(time)}` : null;
  return { badge, stamp };
}

type LabelItem = {
  id: string;
  title: string;
  point: Point;
  radius: number;
  stamp: string | null;
  badge: string | null;
};

export type LabelBox = {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
};

export type OutsideLabel = LabelBox & {
  lines: string[];
  stamp: string | null;
};

const anchors = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, -1],
  [-1, -1],
  [1, 1],
  [-1, 1],
];

function labelBoxOverlaps(a: LabelBox, b: LabelBox, gap: number) {
  return (
    Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth + gap &&
    Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight + gap
  );
}

export function outsideLabels(
  items: readonly LabelItem[],
  scale: number,
  visibleBands: readonly RadarBand[],
  reserved: readonly LabelBox[] = [],
) {
  const labels = new Map<string, OutsideLabel>();
  const occupied = [
    ...reserved,
    ...visibleBands.map((band) => {
      const { point, halfWidth, halfHeight } = ringLabel(band);
      return {
        ...point,
        halfWidth: halfWidth / scale,
        halfHeight: halfHeight / scale,
      };
    }),
  ];
  const candidates = items
    // In crowded views, keep full titles available through interaction.
    .filter(({ stamp }) => stamp || items.length <= 32)
    .sort(
      (a, b) =>
        Number(Boolean(b.stamp)) - Number(Boolean(a.stamp)) ||
        b.radius - a.radius ||
        a.id.localeCompare(b.id),
    );
  for (const item of candidates) {
    const { title, point, radius, stamp, badge } = item;
    const inside = bubbleLabel(title, stamp, badge, radius, scale);
    const insideTitle = inside.lines.join(" ");
    if (
      (!stamp || stamp === inside.visibleBadge?.text) &&
      insideTitle.length >= 0.8 * title.length
    )
      continue;

    const font = RADAR_LABEL_FONT / scale;
    // Try narrower titles and, for timed items, a standalone badge.
    const variants = [100, 68, 50].map((width) => ({
      lines: titleLines(title, width / scale, font),
      stamp,
    }));
    if (stamp && badge) {
      variants.push({ lines: [], stamp });
      if (!inside.visibleBadge) variants.push({ lines: [], stamp: badge });
    }
    for (const { lines, stamp } of variants) {
      const halfWidth =
        Math.max(
          ...lines.map((line) => labelWidth(line, font)),
          stamp ? labelWidth(stamp, font) : 0,
        ) /
          2 +
        4 / scale;
      const halfHeight =
        (((lines.length + Number(Boolean(stamp))) * RADAR_LABEL_FONT) / 2 + 3) /
        scale;
      const slot = anchors
        .map(([dx, dy]) => ({
          x:
            point.x +
            dx * (halfWidth + (radius + 5 / scale) / Math.hypot(dx, dy)),
          y:
            point.y +
            dy * (halfHeight + (radius + 5 / scale) / Math.hypot(dx, dy)),
          halfWidth,
          halfHeight,
        }))
        .find(
          (box) =>
            Math.hypot(
              Math.abs(box.x - CENTER.x) + halfWidth,
              Math.abs(box.y - CENTER.y) + halfHeight,
            ) <=
              RADAR_RADIUS - 2 &&
            !occupied.some((other) =>
              labelBoxOverlaps(box, other, 2 / scale),
            ) &&
            items.every(
              (other) =>
                Math.hypot(
                  Math.max(0, Math.abs(box.x - other.point.x) - halfWidth),
                  Math.max(0, Math.abs(box.y - other.point.y) - halfHeight),
                ) >=
                other.radius + 4,
            ),
        );
      if (slot) {
        occupied.push(slot);
        labels.set(item.id, { ...slot, lines, stamp });
        break;
      }
    }
  }
  return labels;
}
