import { expect, it } from "vitest";
import { sheetHeights, snapSheet } from "./mobile-sheet";

it("sizes the three stops against the space above the dock", () => {
  expect(sheetHeights(640)).toEqual({ peek: 132, half: 320, full: 640 });
  expect(sheetHeights(200)).toEqual({ peek: 100, half: 100, full: 200 });
});

it("snaps to the nearest stop and preserves the current stop on a tie", () => {
  expect(snapSheet(200, 0, 600, "peek")).toBe("peek");
  expect(snapSheet(270, 0, 600, "peek")).toBe("half");
  expect(snapSheet(500, 0, 600, "half")).toBe("full");
  expect(snapSheet(450, 0, 600, "full")).toBe("full");
  expect(snapSheet(100, 0, 200, "half")).toBe("half");
});

it("uses release velocity to distinguish flicks from slow drags", () => {
  expect(snapSheet(185, 0.6, 600, "peek")).toBe("half");
  expect(snapSheet(340, 0.9, 600, "half")).toBe("full");
  expect(snapSheet(470, -0.8, 600, "full")).toBe("half");
  expect(snapSheet(290, -0.8, 600, "half")).toBe("peek");
});
