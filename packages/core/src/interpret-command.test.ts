import { describe, expect, it } from "vitest";
import { interpretCommand, type CommandContext } from "./interpret-command.js";

const sdk = { id: "sdk", title: "SDK upgrade" };
const sdkDocs = { id: "docs", title: "SDK documentation" };
const other = { id: "other", title: "Build API", handoff: 1 };
const context: CommandContext = {
  items: [sdk, sdkDocs, other],
  today: Date.parse("2026-11-23T02:30:00Z"),
  timezone: "America/Los_Angeles",
};

describe("interpretCommand", () => {
  it.each([
    ["today", "2026-11-22"],
    ["tomorrow", "2026-11-23"],
    ["move to tomorrow", "2026-11-23"],
    ["schedule for tomorrow", "2026-11-23"],
    ["Sunday", "2026-11-22"],
    ["Friday", "2026-11-27"],
    ["next week", "2026-11-23"],
    ["2028-02-29", "2028-02-29"],
  ])("schedules %s by the workspace calendar", (command, date) => {
    expect(
      interpretCommand(command, { ...context, selected: sdk }),
    ).toMatchObject({
      type: "mutate",
      mutation: {
        type: "UPDATE_ITEM",
        input: { item_id: sdk.id, scheduled_on: date },
      },
    });
  });

  it.each(["move the sdk to Friday", "make sdk high", "done SDK"])(
    "reports candidates for ambiguous names in %s",
    (command) => {
      expect(interpretCommand(command, context)).toMatchObject({
        type: "message",
        text: expect.stringMatching(/SDK upgrade, SDK documentation/),
      });
    },
  );

  it.each([
    [
      "mark API done",
      { type: "SET_STATUS", input: { item_id: other.id, status: "done" } },
    ],
    [
      "hide Upgra",
      { type: "UPDATE_ITEM", input: { item_id: sdk.id, hidden: true } },
    ],
    [
      "show SDK doc",
      { type: "UPDATE_ITEM", input: { item_id: sdkDocs.id, hidden: false } },
    ],
    [
      "cancel SDK upgrade",
      { type: "SET_STATUS", input: { item_id: sdk.id, status: "cancelled" } },
    ],
    [
      "reopen SDK upgrade because new failure",
      {
        type: "REOPEN_ITEM",
        input: { item_id: sdk.id, reason: "new failure" },
      },
    ],
    [
      "move the SDK upgrade to Friday",
      {
        type: "UPDATE_ITEM",
        input: { item_id: sdk.id, scheduled_on: "2026-11-27" },
      },
    ],
    [
      "add Write tests",
      {
        type: "ADD_ITEM",
        input: {
          title: "Write tests",
          project: "inbox",
          scheduled_on: "2026-11-22",
        },
      },
    ],
    [
      "new token for Claude Code",
      {
        type: "CREATE_TOKEN",
        input: { label: "Claude Code", scope: "report" },
      },
    ],
  ])("interprets %s", (command, mutation) => {
    expect(interpretCommand(command, context)).toMatchObject({
      type: "mutate",
      mutation,
    });
  });

  it.each([
    ["urgent", 10],
    ["high", 8],
    ["normal", 5],
    ["low", 2],
  ])("sets %s priority", (word, priority) => {
    expect(
      interpretCommand(`make it ${word}`, { ...context, selected: sdk }),
    ).toMatchObject({
      type: "mutate",
      mutation: { input: { item_id: sdk.id, priority } },
    });
  });

  it.each([
    ["zoom into today", { type: "zoom", band: "today" }],
    ["zoom into this week", { type: "zoom", band: "this-week" }],
    ["fit", { type: "zoom", band: null }],
    ["show this week by day", { type: "zoom", band: "this-week" }],
    ["switch lens to board", { type: "lens", id: "board" }],
    ["What needs me?", { type: "workspace", command: "what needs me" }],
    ["what is blocked", { type: "workspace", command: "what is blocked" }],
    ["edit guidance", { type: "workspace", command: "edit guidance" }],
    ["sign out", { type: "workspace", command: "sign out" }],
    ["this is free text", { type: "unknown" }],
    ["2027-02-29", { type: "message", text: "Enter a valid calendar date." }],
  ])("routes %s", (command, intent) => {
    expect(interpretCommand(command, context)).toEqual(intent);
  });

  it.each(["reply with Ship it", "Ship it"])(
    "answers the selected question with %s",
    (command) => {
      expect(
        interpretCommand(command, { ...context, selected: other }),
      ).toMatchObject({
        type: "mutate",
        mutation: {
          type: "ANSWER_HANDOFF",
          input: { item_id: other.id, text: "Ship it" },
        },
      });
    },
  );

  it("keeps command-shaped answers literal in reply mode", () => {
    expect(
      interpretCommand("Friday", { ...context, selected: sdk, replyTo: other }),
    ).toMatchObject({
      type: "mutate",
      mutation: {
        type: "ANSWER_HANDOFF",
        input: { item_id: other.id, text: "Friday" },
      },
    });
  });
});
