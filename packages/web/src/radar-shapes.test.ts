import { expect, it } from "vitest";
import { shapePath, shapeTop } from "./radar-shapes";

it("starts every outline at the top so progress begins at twelve o'clock", () => {
  for (const shape of ["circle", "square", "diamond", "hexagon"] as const) {
    const [x, y] = shapePath(shape, 20).split(" ").slice(1, 3).map(Number);
    expect(x).toBe(0);
    expect(y).toBeCloseTo(-shapeTop(shape, 20), 1);
  }
});

it("keeps the area of the circle so size still reads as priority", () => {
  const circle = Math.PI * 20 ** 2;
  const square = (2 * shapeTop("square", 20)) ** 2;
  const diamond = 2 * shapeTop("diamond", 20) ** 2;
  const hexagon = ((3 * Math.sqrt(3)) / 2) * shapeTop("hexagon", 20) ** 2;
  for (const area of [square, diamond, hexagon])
    expect(area / circle).toBeCloseTo(1, 3);
});
