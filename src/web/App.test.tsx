import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SocketMessage } from "../shared/workspace-socket";
import { App } from "./App";
import { lensRegistry, type Lens } from "./lenses";
import { child, goal, project, snapshot, tomorrow } from "./workspace-fixtures";

class TestSocket extends EventTarget {
  static OPEN = 1;
  static current: TestSocket;
  readyState = TestSocket.OPEN;
  send = vi.fn();

  constructor() {
    super();
    TestSocket.current = this;
  }

  receive(message: SocketMessage) {
    act(() =>
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(message) }),
      ),
    );
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const fetchSession = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSession);
  vi.stubGlobal("WebSocket", TestSocket);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2024-04-03T12:00:00Z"));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchSession.mockReset();
});

it.each([true, false])(
  "uses the signed-out configuration to show development sign-in (%s)",
  async (devLoginEnabled) => {
    fetchSession.mockResolvedValue(
      Response.json({ devLoginEnabled }, { status: 401 }),
    );
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain(
      "Checking your session",
    );
    expect(
      (
        await screen.findByRole("link", { name: "Sign in with Google" })
      ).getAttribute("href"),
    ).toBe("/auth/login");
    const devLink = screen.queryByRole("link", { name: "Development sign-in" });
    expect(devLink?.getAttribute("href")).toBe(
      devLoginEnabled ? "/auth/dev-login" : undefined,
    );
    expect(
      screen.queryByRole("heading", { name: "Horizon Stream" }),
    ).toBeNull();
  },
);

async function openWorkspace(
  registry?: readonly [Lens, ...Lens[]],
  initialSnapshot: Extract<SocketMessage, { type: "SNAPSHOT" }> = snapshot,
) {
  fetchSession.mockImplementation(async () =>
    Response.json({ workspaceId: "default", email: "person@example.test" }),
  );
  const previousSocket = TestSocket.current;
  const view = render(<App registry={registry} />);
  await waitFor(() => expect(TestSocket.current).not.toBe(previousSocket));
  TestSocket.current.receive(initialSnapshot);
  return view;
}

it("cross-highlights nested and banded rows, and hides them when the project is toggled", async () => {
  localStorage.setItem("heed.lens", "list");
  await openWorkspace();
  const list = within(screen.getByRole("region", { name: "List" }));
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  const today = within(
    stream.getByRole("heading", { name: "Today" }).parentElement!,
  );
  expect(today.getByRole("button", { name: goal.title })).toBeTruthy();
  const streamRow = today.getByRole("button", { name: child.title });
  const lensRow = list.getByRole("button", { name: new RegExp(child.title) });
  expect(
    stream.getByRole("heading", { name: "Tomorrow" }).parentElement
      ?.textContent,
  ).toContain(tomorrow.title);
  fireEvent.click(streamRow);
  expect(lensRow.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(list.getByRole("button", { name: new RegExp(goal.title) }));
  expect(
    today
      .getByRole("button", { name: goal.title })
      .getAttribute("aria-pressed"),
  ).toBe("true");

  const chip = screen.getByRole("button", { name: "Inbox" });
  fireEvent.click(chip);
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryAllByText(child.title)).toEqual([]);
  expect(JSON.parse(TestSocket.current.send.mock.lastCall![0])).toMatchObject({
    type: "UPDATE_PROJECT",
    project_id: project.id,
    input: { hidden: 1 },
  });
});

it("keeps fall-back completions in Done today until workspace midnight", async () => {
  const completed_at = "2026-11-01T04:05:00Z";
  vi.mocked(Date.now).mockReturnValue(Date.parse(completed_at));
  localStorage.setItem("heed.lens", "list");
  await openWorkspace();
  TestSocket.current.receive({
    ...snapshot,
    seq: 2,
    settings: { ...snapshot.settings, timezone: "America/New_York" },
    items: [goal, child],
  });
  TestSocket.current.receive({
    type: "ITEM_UPSERT",
    seq: 3,
    item: { ...goal, status: "done", completed_at },
  });
  TestSocket.current.receive({
    type: "ITEM_UPSERT",
    seq: 4,
    item: { ...child, status: "done", completed_at },
  });

  const list = within(screen.getByRole("region", { name: "List" }));
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  const doneToday = () =>
    within(stream.getByRole("heading", { name: "Done today" }).parentElement!);
  const advanceTo = (time: string) => {
    vi.mocked(Date.now).mockReturnValue(Date.parse(time));
    fireEvent(document, new Event("visibilitychange"));
  };

  const listGoal = { name: new RegExp(goal.title) };
  expect(list.getByRole("button", listGoal)).toBeTruthy();
  expect(doneToday().getByRole("button", { name: goal.title })).toBeTruthy();

  advanceTo("2026-11-02T04:30:00Z");
  expect(list.queryByRole("button", listGoal)).toBeNull();
  const row = doneToday().getByRole("button", { name: goal.title });
  fireEvent.click(row);
  expect(row.getAttribute("aria-pressed")).toBe("true");

  const attention = stream.getByRole("button", { name: "Needs me 1" });
  fireEvent.click(attention);
  expect(doneToday().queryByRole("button", { name: goal.title })).toBeNull();
  expect(doneToday().getByRole("button", { name: child.title })).toBeTruthy();

  const projectToggle = screen.getByRole("button", { name: project.name });
  fireEvent.click(projectToggle);
  expect(stream.queryByRole("heading", { name: "Done today" })).toBeNull();
  fireEvent.click(projectToggle);
  fireEvent.click(attention);
  expect(doneToday().getByRole("button", { name: goal.title })).toBeTruthy();

  advanceTo("2026-11-02T05:00:00Z");
  expect(stream.queryByRole("heading", { name: "Done today" })).toBeNull();
});

it("shows a nested List item as blocked by a hidden item until it completes", async () => {
  localStorage.setItem("heed.lens", "list");
  await openWorkspace();
  const socket = TestSocket.current;
  const blocker = { ...goal, id: "blocker", hidden: 1 as const };
  const dependency = { item_id: tomorrow.id, blocked_by_id: blocker.id };
  const list = within(screen.getByRole("region", { name: "List" }));

  socket.receive({
    ...snapshot,
    seq: 2,
    items: [...snapshot.items, blocker],
    dependencies: [dependency],
  });
  const row = within(
    list.getByRole("button", { name: new RegExp(tomorrow.title) }),
  );
  expect(row.getByText("Blocked")).toBeTruthy();

  socket.receive({
    type: "ITEM_UPSERT",
    seq: 3,
    item: { ...blocker, status: "done", completed_at: "2024-04-03T12:00:00Z" },
  });
  expect(row.getByText("Queued")).toBeTruthy();
});

it("updates List status when a dependency is added or removed live", async () => {
  localStorage.setItem("heed.lens", "list");
  await openWorkspace();
  const socket = TestSocket.current;
  const dependency = { item_id: goal.id, blocked_by_id: tomorrow.id };
  const list = within(screen.getByRole("region", { name: "List" }));
  const row = within(
    list.getByRole("button", { name: new RegExp(goal.title) }),
  );
  expect(row.getByText("Queued")).toBeTruthy();

  socket.receive({ type: "DEPENDENCY_ADD", seq: 2, dependency });
  expect(row.getByText("Blocked")).toBeTruthy();

  socket.receive({ type: "DEPENDENCY_REMOVE", seq: 3, dependency });
  expect(row.getByText("Queued")).toBeTruthy();
});

it("switches registered lenses, retains the selection and remembers the lens on reload", async () => {
  const detail: Lens = {
    id: "detail",
    label: "Detail",
    component: ({ selectedId }) => <p>Selected item {selectedId}</p>,
  };
  const registry = [lensRegistry[0], detail] as const;
  const view = await openWorkspace(registry);
  fireEvent.click(
    within(screen.getByRole("region", { name: "Horizon Stream" })).getByRole(
      "button",
      { name: child.title },
    ),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Lens" }), {
    target: { value: detail.id },
  });
  expect(screen.getByText("Selected item child")).toBeTruthy();
  view.unmount();

  await openWorkspace(registry);
  expect(screen.getByRole("heading", { name: "Detail" })).toBeTruthy();
});

it("requests one replacement snapshot on a sequence gap", async () => {
  await openWorkspace();
  const socket = TestSocket.current;
  socket.receive({ type: "ITEM_REMOVE", seq: 3, item_id: goal.id });
  socket.receive({ type: "ITEM_REMOVE", seq: 4, item_id: child.id });
  expect(socket.send.mock.calls).toEqual([
    [JSON.stringify({ type: "GET_SNAPSHOT" })],
  ]);
  expect(screen.getByRole("status").textContent).toContain(
    "Synchronizing workspace",
  );
  socket.receive({ ...snapshot, seq: 5, items: [] });
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText("No items in this view.")).toBeTruthy();
});

it("sends the browser timezone only when the workspace has none", async () => {
  const view = await openWorkspace();
  expect(TestSocket.current.send).not.toHaveBeenCalled();
  view.unmount();
  await openWorkspace(undefined, { ...snapshot, timezoneConfigured: false });
  expect(JSON.parse(TestSocket.current.send.mock.lastCall![0])).toMatchObject({
    type: "INITIALIZE_TIMEZONE",
    input: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
});

it("uses fresh timestamps when a heartbeat arrives between minute ticks", async () => {
  await openWorkspace();
  vi.mocked(Date.now).mockReturnValue(Date.parse("2024-04-03T12:00:20Z"));
  TestSocket.current.receive({
    type: "ITEM_UPSERT",
    seq: 2,
    item: {
      ...goal,
      status: "active",
      agent_name: "Build agent",
      last_heartbeat_at: "2024-04-03T12:00:19Z",
    },
  });
  expect(screen.getByText("1 agent live")).toBeTruthy();
});

it("reconnects with backoff and accepts a fresh connection sequence", async () => {
  await openWorkspace();
  vi.useFakeTimers();
  try {
    const first = TestSocket.current;
    act(() => first.close());
    expect(screen.getByRole("status").textContent).toContain("Reconnecting");
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const second = TestSocket.current;
    expect(second).not.toBe(first);

    act(() => second.close());
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(TestSocket.current).toBe(second);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(TestSocket.current).not.toBe(second);
    TestSocket.current.receive({ ...snapshot, items: [] });
    expect(screen.getByText("No items in this view.")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("defaults to Radar, opens a goal, and cross-highlights and resizes its children", async () => {
  await openWorkspace();
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  const socket = TestSocket.current;
  socket.receive({
    type: "DEPENDENCY_ADD",
    seq: 2,
    dependency: {
      item_id: tomorrow.id,
      blocked_by_id: child.id,
    },
  });
  expect(radar.queryByRole("button", { name: child.title })).toBeNull();

  fireEvent.click(radar.getByRole("button", { name: goal.title }));
  expect(
    radar.getByRole("navigation", { name: "Goal breadcrumb" }),
  ).toBeTruthy();
  expect(
    stream
      .getByRole("button", { name: goal.title })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen
      .getByLabelText(`Items in ${goal.title}`)
      .querySelector(".radar-edge"),
  ).toBeTruthy();

  fireEvent.click(stream.getByRole("button", { name: child.title }));
  expect(
    radar
      .getByRole("button", { name: child.title })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.keyDown(
    radar.getByRole("slider", { name: `Priority for ${child.title}` }),
    { key: "End" },
  );
  expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: child.id, priority: 10 },
  });
  fireEvent.click(radar.getByRole("button", { name: "All projects" }));
  expect(radar.getByRole("button", { name: goal.title })).toBeTruthy();
});

it("keeps radar positions on status updates and filters attention and completed ghosts", async () => {
  await openWorkspace();
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  const socket = TestSocket.current;
  const finished = {
    ...goal,
    id: "finished",
    title: "Shipped work",
    status: "done",
    completed_at: "2024-04-03T12:00:00Z",
    completed_band: "later",
  } as const;
  socket.receive({ ...snapshot, seq: 2, items: [...snapshot.items, finished] });
  const marker = () =>
    radar
      .getByRole("button", { name: goal.title })
      .parentElement?.getAttribute("transform");
  const before = marker();
  socket.receive({
    type: "ITEM_UPSERT",
    seq: 3,
    item: {
      ...goal,
      status: "active",
      last_heartbeat_at: "2024-04-03T11:58:00Z",
    },
  });
  expect(marker()).toBe(before);
  socket.receive({
    type: "ITEM_UPSERT",
    seq: 4,
    item: {
      ...goal,
      status: "blocked",
    },
  });
  expect(marker()).toBe(before);
  const ghost = radar.getByRole("button", { name: finished.title });
  expect(ghost.getAttribute("data-ghost")).toBe("true");
  fireEvent.click(
    radar.getByRole("checkbox", { name: "Show completed ghosts" }),
  );
  expect(radar.queryByRole("button", { name: finished.title })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Needs me 1" }));
  expect(radar.queryByRole("button", { name: goal.title })).toBeNull();
  expect(radar.getByRole("button", { name: child.title })).toBeTruthy();
});

it("offers a registered Dependencies lens for the focused goal", async () => {
  const dependencies: Lens = {
    id: "dependencies",
    label: "Dependencies",
    component: ({ goalId }) => <p>Dependencies for {goalId}</p>,
  };
  await openWorkspace([lensRegistry[0], dependencies]);
  expect(screen.queryByRole("option", { name: "Dependencies" })).toBeNull();
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  fireEvent.click(radar.getByRole("button", { name: goal.title }));
  fireEvent.click(radar.getByRole("button", { name: "Dependencies" }));
  expect(screen.getByText("Dependencies for goal")).toBeTruthy();
});

it("opens the selected child's goal when switching from List to Radar", async () => {
  localStorage.setItem("heed.lens", "list");
  await openWorkspace();
  const list = within(screen.getByRole("region", { name: "List" }));
  fireEvent.click(list.getByRole("button", { name: new RegExp(child.title) }));
  fireEvent.change(screen.getByRole("combobox", { name: "Lens" }), {
    target: { value: "radar" },
  });
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  expect(
    radar
      .getByRole("button", { name: child.title })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
