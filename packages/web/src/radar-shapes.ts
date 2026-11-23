import type { ItemShape } from "@heedwork/core";

// Each shape has the area of a circle of radius r, so size still reads as priority.
const SQUARE_HALF = Math.sqrt(Math.PI) / 2; // ≈ 0.886
const DIAMOND_TIP = Math.sqrt(Math.PI / 2); // ≈ 1.253
const HEXAGON_TIP = Math.sqrt((2 * Math.PI) / (3 * Math.sqrt(3))); // ≈ 1.100

const round = (value: number) => Math.round(value * 100) / 100;

/** An outline starting at the top and running clockwise, so a progress arc starts at twelve o'clock. */
export function shapePath(shape: ItemShape, r: number): string {
  switch (shape) {
    case "square": {
      const h = round(r * SQUARE_HALF);
      const c = round(h * 0.22);
      return [
        `M 0 ${-h} H ${h - c} Q ${h} ${-h} ${h} ${-h + c}`,
        `V ${h - c} Q ${h} ${h} ${h - c} ${h}`,
        `H ${-h + c} Q ${-h} ${h} ${-h} ${h - c}`,
        `V ${-h + c} Q ${-h} ${-h} ${-h + c} ${-h} Z`,
      ].join(" ");
    }
    case "diamond": {
      const d = round(r * DIAMOND_TIP);
      return `M 0 ${-d} L ${d} 0 L 0 ${d} L ${-d} 0 Z`;
    }
    case "hexagon": {
      const R = r * HEXAGON_TIP;
      const points = [0, 1, 2, 3, 4, 5].map((index) => {
        const angle = -Math.PI / 2 + (index * Math.PI) / 3;
        return `${round(R * Math.cos(angle))} ${round(R * Math.sin(angle))}`;
      });
      return `M ${points.join(" L ")} Z`;
    }
    default: {
      const s = round(r);
      return `M 0 ${-s} A ${s} ${s} 0 1 1 0 ${s} A ${s} ${s} 0 1 1 0 ${-s} Z`;
    }
  }
}

/** How far the shape reaches above its centre, where the project badge sits. */
export function shapeTop(shape: ItemShape, r: number): number {
  switch (shape) {
    case "square":
      return r * SQUARE_HALF;
    case "diamond":
      return r * DIAMOND_TIP;
    case "hexagon":
      return r * HEXAGON_TIP;
    default:
      return r;
  }
}
