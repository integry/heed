import { expect, it } from "vitest";
import {
  AddItemSchema,
  ReportProgressSchema,
  UpdateItemSchema,
} from "./item-operations.js";

it.each([
  { schema: AddItemSchema, required: { title: "Release" } },
  { schema: UpdateItemSchema, required: { item_id: "release" } },
])("validates and trims acceptance criteria", ({ schema, required }) => {
  const criterion = "🙂".repeat(200);
  const acceptance = Array<string>(8).fill(criterion);
  expect(
    schema.parse({ ...required, acceptance: acceptance.map((s) => ` ${s} `) }),
  ).toMatchObject({ acceptance });
  expect(schema.parse({ ...required, acceptance: [] })).toMatchObject({
    acceptance: [],
  });
  for (const [value, message] of [
    [[...acceptance, "extra"], "Provide at most 8 acceptance criteria"],
    [
      [criterion + "🙂"],
      "Each acceptance criterion must be at most 200 characters",
    ],
    [[""], "Acceptance criteria must not be empty"],
    [[" \t "], "Acceptance criteria must not be empty"],
  ] as const) {
    expect(() => schema.parse({ ...required, acceptance: value })).toThrow(
      message,
    );
  }
  expect(schema.safeParse({ ...required, acceptance: "verify" }).success).toBe(
    false,
  );
  expect(schema.safeParse({ ...required, acceptance: [123] }).success).toBe(
    false,
  );
});

it("preserves evidence text at the character limit", () => {
  const evidence = "  " + "🙂".repeat(3_997) + "\n";
  const input = { item_id: "release", status: "done", evidence };
  expect(ReportProgressSchema.parse(input)).toEqual(input);
  expect(() =>
    ReportProgressSchema.parse({ ...input, evidence: evidence + "🙂" }),
  ).toThrow("Evidence must be at most 4,000 characters");
});
