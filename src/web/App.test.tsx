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

async function openWorkspace(registry?: readonly [Lens, ...Lens[]]) {
  fetchSession.mockImplementation(async () =>
    Response.json({ workspaceId: "default", email: "person@example.test" }),
  );
  const previous = TestSocket.current;
  const view = render(<App registry={registry} />);
  await screen.findByRole("heading", { name: "Horizon Stream" });
  await waitFor(() => expect(TestSocket.current).not.toBe(previous));
  TestSocket.current.receive(snapshot);
  return view;
}

it("cross-highlights nested and banded rows, and hides them when the project is toggled", async () => {
  await openWorkspace();
  const list = within(screen.getByRole("region", { name: "List" }));
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  const today = within(
    stream.getByRole("heading", { name: "Today" }).parentElement!,
  );
  expect(today.getByRole("button", { name: goal.title })).toBeTruthy();
  expect(today.queryByRole("button", { name: child.title })).toBeNull();
  fireEvent.click(today.getByRole("button", { name: `Expand ${goal.title}` }));
  const streamRow = today.getByRole("button", { name: child.title });
  expect(today.getByRole("button", { name: tomorrow.title })).toBeTruthy();
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

it("keeps fall-back completions in Completed earlier today until workspace midnight", async () => {
  const completed_at = "2026-11-01T04:05:00Z";
  vi.mocked(Date.now).mockReturnValue(Date.parse(completed_at));
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
    within(
      stream.getByRole("heading", { name: /Completed earlier today/ })
        .parentElement!,
    );
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
  expect(doneToday().getByRole("button", { name: goal.title })).toBeTruthy();
  expect(doneToday().getByRole("button", { name: child.title })).toBeTruthy();

  const projectToggle = screen.getByRole("button", { name: project.name });
  fireEvent.click(projectToggle);
  expect(
    stream.queryByRole("heading", { name: /Completed earlier today/ }),
  ).toBeNull();
  fireEvent.click(projectToggle);
  fireEvent.click(attention);
  expect(doneToday().getByRole("button", { name: goal.title })).toBeTruthy();

  advanceTo("2026-11-02T05:00:00Z");
  expect(
    stream.queryByRole("heading", { name: /Completed earlier today/ }),
  ).toBeNull();
});

it("shows a nested List item as blocked by a hidden item until it completes", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: `Expand ${goal.title}` }));
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
  fetchSession.mockImplementation(async () =>
    Response.json({ workspaceId: "default", email: "person@example.test" }),
  );
  const previous = TestSocket.current;
  render(<App />);
  await screen.findByRole("heading", { name: "Horizon Stream" });
  await waitFor(() => expect(TestSocket.current).not.toBe(previous));
  TestSocket.current.receive({ ...snapshot, timezoneConfigured: false });
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

it("orders fixed, manual and priority work, and shows time and attention metadata", async () => {
  await openWorkspace();
  const titled = (title: string) => ({
    ...goal,
    id: title,
    title,
    progress: { done: 0, total: 0 },
  });
  TestSocket.current.receive({
    ...snapshot,
    seq: 2,
    items: [
      { ...titled("Low priority"), priority: 1 },
      {
        ...titled("Carried over"),
        priority: 9,
        scheduled_on: "2024-04-02",
        reopen_count: 1,
      },
      {
        ...titled("Manual"),
        sort_key: 2,
        time_type: "deadline",
        time_at: "2024-04-03T16:00:00Z",
      },
      {
        ...titled("Second meeting"),
        time_type: "fixed",
        time_at: "2024-04-03T12:00:00Z",
      },
      {
        ...titled("First meeting"),
        time_type: "fixed",
        time_at: "2024-04-03T08:00:00Z",
      },
    ],
  });
  const today = within(screen.getByRole("region", { name: "Today" }));
  expect(
    today
      .getAllByRole("button", { pressed: false })
      .map((row) => row.getAttribute("aria-label")),
  ).toEqual([
    "First meeting",
    "Second meeting",
    "Manual",
    "Carried over",
    "Low priority",
  ]);
  expect(today.getByText(/DUE/)).toBeTruthy();
  expect(today.getByText("from Tue").getAttribute("datetime")).toBe(
    "2024-04-02",
  );
  expect(today.getByText("Reopened")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Tomorrow & this week" }),
  ).toBeTruthy();
});

it("filters both panes to stale and handoff work with ancestors, including across bands", async () => {
  await openWorkspace();
  const stale = {
    ...goal,
    id: "stale",
    title: "Stale export",
    status: "active" as const,
    agent_name: "Agent A",
    last_heartbeat_at: "2024-04-03T10:00:00Z",
  };
  TestSocket.current.receive({
    ...snapshot,
    seq: 2,
    items: [goal, { ...child, handoff: 0 }, { ...tomorrow, handoff: 1 }, stale],
  });
  fireEvent.click(screen.getByRole("button", { name: "Needs me 2" }));
  const list = within(screen.getByRole("region", { name: "List" }));
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  for (const pane of [list, stream]) {
    expect(
      pane.queryByRole("button", { name: new RegExp(`^${child.title}`) }),
    ).toBeNull();
    expect(
      pane.getByRole("button", { name: new RegExp(`^${goal.title}`) }),
    ).toBeTruthy();
    expect(
      pane.getByRole("button", { name: new RegExp(`^${stale.title}`) }),
    ).toBeTruthy();
  }
  expect(
    within(screen.getByRole("region", { name: "Tomorrow" })).getByRole(
      "button",
      { name: tomorrow.title },
    ),
  ).toBeTruthy();
  expect(stream.getByText(/last seen 2 hours ago/)).toBeTruthy();
});

it("reveals a collapsed selected row from the lens and scrolls it into view", async () => {
  await openWorkspace();
  const scrollIntoView = vi.fn();
  const scroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  try {
    const list = within(screen.getByRole("region", { name: "List" }));
    const today = within(screen.getByRole("region", { name: "Today" }));
    fireEvent.click(
      list.getByRole("button", { name: new RegExp(child.title) }),
    );
    expect(
      today
        .getByRole("button", { name: child.title })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  } finally {
    if (scroll)
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it("writes a fractional key on pointer drop and reschedules or clears a date with the keyboard", async () => {
  await openWorkspace();
  const first = { ...goal, id: "first", title: "First", sort_key: 10 };
  const second = { ...goal, id: "second", title: "Second", sort_key: 20 };
  const moved = { ...goal, id: "moved", title: "Move this", sort_key: 30 };
  const later = {
    ...goal,
    id: "later",
    title: "Later item",
    scheduled_on: "2024-04-08",
  };
  TestSocket.current.receive({
    ...snapshot,
    seq: 2,
    items: [first, second, moved, later],
  });
  const handle = screen.getByRole("button", { name: "Move Move this" });
  const target = screen.getByRole("button", {
    name: second.title,
  }).parentElement!;
  Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
  const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => target,
  });
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 40, 100, 40),
  );
  const socket = TestSocket.current;
  const pointer = {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    clientX: 50,
  };
  try {
    fireEvent.pointerDown(handle, { ...pointer, clientY: 100 });
    fireEvent.pointerMove(handle, { ...pointer, clientY: 45 });
    expect(socket.send).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { ...pointer, clientY: 45 });
  } finally {
    if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
  }
  const sent = () => JSON.parse(socket.send.mock.lastCall![0]);
  expect(sent()).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: moved.id, sort_key: 15 },
  });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(sent()).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: moved.id, scheduled_on: "2024-04-04" },
  });
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Later item" }), {
    key: "ArrowRight",
  });
  expect(sent()).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: later.id, scheduled_on: null },
  });
  expect(screen.getByRole("button", { name: later.title })).toBeTruthy();
});

it("filters collapsible backlog project groups by tag", async () => {
  await openWorkspace();
  const unplanned = { ...goal, scheduled_on: null, tags: '["platform"]' };
  const other = {
    ...unplanned,
    id: "other",
    title: "Other backlog work",
    tags: '["quick-win"]',
  };
  TestSocket.current.receive({
    ...snapshot,
    seq: 2,
    items: [unplanned, other],
  });
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  const inbox = stream.getByRole("button", { name: "Inbox 2" });
  expect(inbox.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(inbox);
  expect(stream.getByRole("button", { name: other.title })).toBeTruthy();
  fireEvent.change(
    stream.getByRole("combobox", { name: "Filter backlog by tag" }),
    { target: { value: "platform" } },
  );
  expect(stream.queryByRole("button", { name: other.title })).toBeNull();
  expect(stream.getByRole("button", { name: unplanned.title })).toBeTruthy();
});

it("searches and pages through history, then reopens an item with a reason", async () => {
  await openWorkspace();
  const history_at = "2024-04-02T12:00:00.000Z";
  const old = {
    ...goal,
    id: "old",
    title: "Old incident",
    status: "cancelled",
    history_at,
  };
  const older = { ...old, id: "older", title: "Older incident" };
  const cursor = `${history_at}|${old.id}`;
  const requests: URL[] = [];
  fetchSession.mockImplementation(async (url: string) => {
    const request = new URL(url, "https://heed.test");
    requests.push(request);
    return Response.json(
      request.searchParams.has("before")
        ? { items: [older], next_before: null }
        : { items: [old], next_before: cursor },
    );
  });
  fireEvent.click(screen.getByRole("link", { name: "View history" }));
  await screen.findByText(old.title);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search history" }), {
    target: { value: "incident" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
    target: { value: project.id },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await screen.findByText(older.title);
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual({
    q: "incident",
    project: project.id,
    before: cursor,
  });

  const row = within(screen.getByText(older.title).closest("li")!);
  fireEvent.click(row.getByRole("button", { name: "Reopen" }));
  const submit = row.getByRole("button", { name: "Reopen item" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(row.getByRole("textbox", { name: "Reason for reopening" }), {
    target: { value: "Follow-up requested" },
  });
  fireEvent.click(submit);
  expect(JSON.parse(TestSocket.current.send.mock.lastCall![0])).toMatchObject({
    type: "REOPEN_ITEM",
    input: { item_id: older.id, reason: "Follow-up requested" },
  });
  TestSocket.current.receive({
    type: "ITEM_UPSERT",
    seq: 2,
    item: { ...goal, id: older.id, title: older.title, reopen_count: 1 },
  });
  const history = within(screen.getByRole("region", { name: "History" }));
  expect(history.queryByText(older.title)).toBeNull();
  fireEvent.click(history.getByRole("button", { name: "Back to stream" }));
  expect(
    within(screen.getByRole("region", { name: "Today" })).getByRole("button", {
      name: older.title,
    }),
  ).toBeTruthy();
});
