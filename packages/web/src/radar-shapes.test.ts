import { expect, it } from "vitest";
import { shapeContains, shapePath, shapeTop } from "./radar-shapes";

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

it("hit-tests the outline as drawn rather than the circle of equal area", () => {
  const r = 20;
  // Beyond the square's side but within the circle, and the reverse at a corner.
  expect(shapeContains("circle", r, 0.95 * r, 0)).toBe(true);
  expect(shapeContains("square", r, 0.95 * r, 0)).toBe(false);
  expect(shapeContains("square", r, 0.85 * r, 0)).toBe(true);
  expect(shapeContains("circle", r, 0.8 * r, 0.8 * r)).toBe(false);
  expect(shapeContains("square", r, 0.8 * r, 0.8 * r)).toBe(true);
  // The rounded corner: its midpoint is on the edge, just past it is outside.
  const h = shapeTop("square", r);
  const c = Math.round(h * 0.22 * 100) / 100;
  expect(shapeContains("square", r, h - c / 4 - 0.01, h - c / 4 - 0.01)).toBe(
    true,
  );
  expect(shapeContains("square", r, h - c / 4 + 0.05, h - c / 4 + 0.05)).toBe(
    false,
  );
  // A diamond reaches past the circle on its axes and falls short diagonally.
  expect(shapeContains("diamond", r, 1.2 * r, 0)).toBe(true);
  expect(shapeContains("diamond", r, 0.65 * r, 0.65 * r)).toBe(false);
  // A pointy-top hexagon: tips above and below, flat sides left and right.
  expect(shapeContains("hexagon", r, 0, 1.05 * r)).toBe(true);
  expect(shapeContains("hexagon", r, 0.97 * r, 0)).toBe(false);
  expect(shapeContains("hexagon", r, 0.9 * r, 0)).toBe(true);
});
