import { expect, it } from "vitest";
import {
  defaultProjectCode,
  itemShape,
  nextProjectColor,
  ProjectCodeSchema,
  projectColor,
  projectIdentity,
  readTags,
} from "./project-identity.js";

it("derives a two-letter badge from the project name", () => {
  expect(defaultProjectCode("Goforex")).toBe("GO");
  expect(defaultProjectCode("Trading game")).toBe("TG");
  expect(defaultProjectCode("GoForex")).toBe("GF");
  expect(defaultProjectCode("mcp-test")).toBe("MT");
  expect(ProjectCodeSchema.parse(" gfx ")).toBe("GFX");
  expect(ProjectCodeSchema.safeParse("toolong").success).toBe(false);
});

it("gives new projects the least-used colour and Inbox no identity", () => {
  expect(nextProjectColor([])).toBe("violet");
  expect(nextProjectColor(["violet", "sky", null, "#123456"])).toBe("rose");
  expect(projectColor({ id: "p1", name: "A", color: "lime" })).toBe("lime");
  expect(projectColor({ id: "p1", name: "A", color: "#00ff00" })).toEqual(
    projectColor({ id: "p1", name: "B", color: null }),
  );
  expect(projectIdentity({ id: "inbox", name: "Inbox", color: null })).toBe(
    null,
  );
  expect(
    projectIdentity({ id: "p2", name: "Propr", color: "rose", code: "PX" }),
  ).toEqual({ color: "rose", code: "PX" });
});

it("picks a shape from the first shaped tag", () => {
  expect(
    itemShape(["Call", "review"], { review: "diamond", call: "square" }),
  ).toBe("square");
  expect(itemShape(["misc"], { call: "square" })).toBe("circle");
  expect(itemShape(["call"], undefined)).toBe("circle");
  expect(readTags('["call", 3]')).toEqual(["call"]);
  expect(readTags("not json")).toEqual([]);
});
