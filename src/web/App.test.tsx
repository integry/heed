import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Item } from "../shared/workspace";
import { App } from "./App";

afterEach(cleanup);

it("renders the Heed placeholder page", () => {
  render(<App />);

  expect(screen.getByRole("heading", { name: "Heed" })).toBeTruthy();
  expect(
    screen.getByText("A workspace for human and agent work."),
  ).toBeTruthy();
});

const goal: Item = {
  id: "goal",
  project_id: "inbox",
  parent_id: null,
  external_key: null,
  title: "Payment reliability",
  tags: "[]",
  depth: 1,
  priority: 5,
  scheduled_on: "2024-04-03",
  sort_key: null,
  layout_pos: "{}",
  locked_fields: "[]",
  time_type: "flexible",
  time_at: null,
  status: "queued",
  handoff: 0,
  handoff_note: null,
  reopen_count: 0,
  reopen_reason: null,
  agent_name: null,
  created_by: "human",
  ref_url: null,
  note: null,
  hidden: 0,
  last_heartbeat_at: null,
  completed_at: null,
  created_at: "2024-04-03T00:00:00Z",
  updated_at: "2024-04-03T00:00:00Z",
};
const child: Item = {
  ...goal,
  id: "child",
  parent_id: goal.id,
  depth: 2,
  title: "Review retry policy",
  scheduled_on: null,
  handoff: 1,
};
const tomorrow: Item = {
  ...child,
  id: "tomorrow",
  title: "Run failover drill",
  scheduled_on: "2024-04-04",
  handoff: 0,
};
const canvasTime = {
  now: Date.parse("2024-04-03T12:00:00Z"),
  timezone: "UTC",
};

it("renders derived stream bands, nested rows and the attention count", () => {
  render(
    <App
      canvas={{
        items: [goal, child, tomorrow],
        ...canvasTime,
      }}
    />,
  );

  expect(screen.getByText("Needs me: 1")).toBeTruthy();
  const goalDetails = screen.getByText(goal.title).closest("details");
  expect(goalDetails?.textContent).toContain(child.title);
  expect(goalDetails?.textContent).not.toContain(tomorrow.title);
  const tomorrowSection = screen.getByRole("heading", {
    name: "Tomorrow",
  }).parentElement;
  expect(tomorrowSection?.textContent).toContain(tomorrow.title);
});

it("removes a hidden goal and its children from the stream", () => {
  const { rerender } = render(
    <App canvas={{ items: [goal, child, tomorrow], ...canvasTime }} />,
  );
  expect(screen.getByText(child.title)).toBeTruthy();
  expect(screen.getByText(tomorrow.title)).toBeTruthy();

  rerender(
    <App
      canvas={{
        items: [{ ...goal, hidden: 1 }, child, tomorrow],
        ...canvasTime,
      }}
    />,
  );

  for (const item of [goal, child, tomorrow]) {
    expect(screen.queryByText(item.title)).toBeNull();
  }
  expect(screen.queryByRole("heading", { name: "Today" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Tomorrow" })).toBeNull();
});
