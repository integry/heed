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
import type { SocketMessage, SocketRequest } from "../shared/workspace-socket";
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

  latestRequest() {
    return JSON.parse(this.send.mock.lastCall![0]) as Exclude<
      SocketRequest,
      { type: "GET_SNAPSHOT" }
    >;
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

Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
  configurable: true,
  value(this: HTMLDialogElement) {
    this.open = true;
  },
});

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
  fetchSession.mockImplementation(async (path: string) =>
    path === "/api/me"
      ? Response.json({ workspaceId: "default", email: "person@example.test" })
      : Response.json([]),
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

function inspect(title: string) {
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  fireEvent.click(stream.getByRole("button", { name: title }));
  return within(screen.getByRole("complementary", { name: "Inspector" }));
}

it("sends the inspector actions and displays activity from the item endpoint", async () => {
  await openWorkspace();
  fetchSession.mockImplementation(async () =>
    Response.json([
      {
        id: 1,
        item_id: goal.id,
        kind: "created",
        actor: "human",
        at: goal.created_at,
        detail: null,
      },
    ]),
  );
  const socket = TestSocket.current;
  const inspector = inspect(goal.title);
  expect(await inspector.findByText("Created item")).toBeTruthy();
  expect(fetchSession).toHaveBeenCalledWith(
    `/api/items/${goal.id}/events`,
    expect.anything(),
  );

  let seq = 1;
  async function acknowledge(
    message?: Omit<Extract<SocketMessage, { type: "ITEM_UPSERT" }>, "seq">,
  ) {
    if (message) socket.receive({ ...message, seq: ++seq });
    await act(async () =>
      socket.receive({
        type: "ACK",
        requestId: socket.latestRequest().requestId,
        seq: ++seq,
      }),
    );
  }
  fireEvent.click(inspector.getByRole("button", { name: "Mark done" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "SET_STATUS",
    input: { item_id: goal.id, status: "done" },
  });
  await acknowledge({
    type: "ITEM_UPSERT",
    item: { ...goal, status: "done", completed_at: "2024-04-03T12:00:00Z" },
  });

  fireEvent.click(inspector.getByRole("button", { name: "Reopen" }));
  expect(
    (
      inspector.getByRole("button", {
        name: "Reopen item",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(inspector.getByLabelText("Reason for reopening"), {
    target: { value: "Check the rollback" },
  });
  fireEvent.click(inspector.getByRole("button", { name: "Reopen item" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "REOPEN_ITEM",
    input: { item_id: goal.id, reason: "Check the rollback" },
  });
  await acknowledge({ type: "ITEM_UPSERT", item: goal });

  fireEvent.click(inspector.getByRole("button", { name: "Flag handoff" }));
  fireEvent.change(inspector.getByLabelText("What input do you need?"), {
    target: { value: "Approve the rollback" },
  });
  fireEvent.click(inspector.getByRole("button", { name: "Save handoff" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "FLAG_HANDOFF",
    input: { item_id: goal.id, note: "Approve the rollback" },
  });
  await acknowledge({
    type: "ITEM_UPSERT",
    item: { ...goal, handoff: 1, handoff_note: "Approve the rollback" },
  });
  fireEvent.click(inspector.getByRole("button", { name: "Clear handoff" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "CLEAR_HANDOFF",
    input: { item_id: goal.id },
  });
  await acknowledge({ type: "ITEM_UPSERT", item: goal });

  fireEvent.change(inspector.getByLabelText("Blocked by"), {
    target: { value: tomorrow.id },
  });
  fireEvent.click(inspector.getByRole("button", { name: "Add dependency" }));
  const dependency = { item_id: goal.id, blocked_by_id: tomorrow.id };
  expect(socket.latestRequest()).toMatchObject({
    type: "SET_DEPENDENCY",
    input: { ...dependency, action: "add" },
  });
  socket.receive({ type: "DEPENDENCY_ADD", seq: ++seq, dependency });
  await acknowledge();
  fireEvent.click(inspector.getByRole("button", { name: "Remove" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "SET_DEPENDENCY",
    input: { ...dependency, action: "remove" },
  });
  socket.receive({ type: "DEPENDENCY_REMOVE", seq: ++seq, dependency });
  await acknowledge();

  fireEvent.click(inspector.getByRole("button", { name: "Hide" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: goal.id, hidden: true },
  });
  await acknowledge({ type: "ITEM_UPSERT", item: { ...goal, hidden: 1 } });
  fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
  inspect(goal.title);
  fireEvent.click(inspector.getByRole("button", { name: "Unhide" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: goal.id, hidden: false },
  });
  await acknowledge({ type: "ITEM_UPSERT", item: goal });

  const confirm = vi
    .spyOn(window, "confirm")
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true);
  fireEvent.click(inspector.getByRole("button", { name: "Delete" }));
  expect(socket.latestRequest().type).toBe("UPDATE_ITEM");
  fireEvent.click(inspector.getByRole("button", { name: "Delete" }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(socket.latestRequest()).toMatchObject({
    type: "DELETE_ITEM",
    input: { item_id: goal.id },
  });
  socket.receive({ type: "ITEM_REMOVE", seq: ++seq, item_id: goal.id });
  await acknowledge();
  expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
});

it("unlocks only the chosen field and reflects the server update", async () => {
  await openWorkspace();
  const socket = TestSocket.current;
  const item = { ...goal, locked_fields: '["priority","layout_pos"]' };
  socket.receive({ type: "ITEM_UPSERT", seq: 2, item });
  const inspector = inspect(goal.title);
  fireEvent.click(inspector.getByRole("button", { name: "Unlock priority" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: goal.id, unlock: "priority" },
  });
  socket.receive({
    type: "ITEM_UPSERT",
    seq: 3,
    item: { ...goal, locked_fields: '["layout_pos"]' },
  });
  await act(async () =>
    socket.receive({
      type: "ACK",
      seq: 4,
      requestId: socket.latestRequest().requestId,
    }),
  );
  expect(
    inspector.queryByRole("button", { name: "Unlock priority" }),
  ).toBeNull();
  expect(
    inspector.getByRole("button", { name: "Unlock canvas position" }),
  ).toBeTruthy();
});

it("adds a goal with workspace-local time and explains the child depth cap", async () => {
  await openWorkspace();
  const socket = TestSocket.current;
  const leaf = {
    ...tomorrow,
    title: "Verify the backlog",
    parent_id: child.id,
    depth: 3 as const,
  };
  socket.receive({
    ...snapshot,
    seq: 2,
    items: [goal, child, leaf],
    settings: { ...snapshot.settings, timezone: "America/New_York" },
  });
  const inspector = inspect(leaf.title);
  expect(
    inspector.getByText(
      "This item is a sub-task. Add another sub-task under its parent.",
    ),
  ).toBeTruthy();
  expect(
    inspector.queryByRole("button", { name: "Add child item" }),
  ).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "+ Goal" }));
  const dialog = within(screen.getByRole("dialog", { name: "Add a goal" }));
  fireEvent.change(dialog.getByLabelText("Title"), {
    target: { value: "Plan the rollout" },
  });
  fireEvent.change(dialog.getByLabelText("Schedule"), {
    target: { value: "2024-04-04" },
  });
  fireEvent.change(dialog.getByLabelText("Time type"), {
    target: { value: "fixed" },
  });
  fireEvent.change(dialog.getByLabelText("Fixed time (America/New_York)"), {
    target: { value: "2024-04-04T09:15" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Add goal" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "ADD_ITEM",
    input: {
      title: "Plan the rollout",
      project: "inbox",
      scheduled_on: "2024-04-04",
      time_type: "fixed",
      time_at: "2024-04-04T13:15:00.000Z",
    },
  });
  await act(async () =>
    socket.receive({
      type: "ACK",
      seq: 3,
      requestId: socket.latestRequest().requestId,
    }),
  );

  // Horizon Stream rows start collapsed, so reveal the child under its goal.
  fireEvent.click(screen.getByRole("button", { name: `Expand ${goal.title}` }));
  const parent = inspect(child.title);
  fireEvent.click(parent.getByRole("button", { name: "Add child item" }));
  const childForm = within(
    screen.getByRole("dialog", { name: "Add child item" }),
  );
  fireEvent.change(childForm.getByLabelText("Title"), {
    target: { value: "Check retry metrics" },
  });
  fireEvent.click(childForm.getByRole("button", { name: "Add child" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "ADD_ITEM",
    input: { title: "Check retry metrics", parent_id: child.id },
  });
  await act(async () =>
    socket.receive({
      type: "ACK",
      seq: 4,
      requestId: socket.latestRequest().requestId,
    }),
  );
});

it.each([
  { dialogName: "Add a goal", openName: "+ Goal", submitName: "Add goal" },
  {
    dialogName: "Add child item",
    openName: "Add child item",
    submitName: "Add child",
  },
])(
  "keeps a reopened $dialogName draft when the first save completes",
  async ({ dialogName, openName, submitName }) => {
    await openWorkspace();
    if (submitName === "Add child") inspect(goal.title);
    const open = screen.getByRole("button", { name: openName });
    fireEvent.click(open);
    const first = within(screen.getByRole("dialog", { name: dialogName }));
    fireEvent.change(first.getByLabelText("Title"), {
      target: { value: "First draft" },
    });
    fireEvent.click(first.getByRole("button", { name: submitName }));
    const socket = TestSocket.current;
    const request = socket.latestRequest();
    expect(request).toMatchObject({
      type: "ADD_ITEM",
      input: { title: "First draft" },
    });

    fireEvent.click(first.getByRole("button", { name: "Close" }));
    fireEvent.click(open);
    const reopened = screen.getByRole("dialog", { name: dialogName });
    fireEvent.change(within(reopened).getByLabelText("Title"), {
      target: { value: "New draft" },
    });
    await act(async () =>
      socket.receive({ type: "ACK", seq: 2, requestId: request.requestId }),
    );
    expect(screen.getByRole("dialog", { name: dialogName })).toBe(reopened);
    expect(within(reopened).getByDisplayValue("New draft")).toBeTruthy();
  },
);

it("enforces the guidance limit and applies settings broadcasts to an open editor", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Guidance" }));
  const editor = within(screen.getByRole("dialog", { name: "Guidance" }));
  const textarea = editor.getByLabelText("Instructions for your agents");
  const save = editor.getByRole("button", {
    name: "Save guidance",
  }) as HTMLButtonElement;
  const socket = TestSocket.current;

  socket.receive({
    type: "SETTINGS_UPDATE",
    seq: 2,
    settings: {
      ...snapshot.settings,
      guidance: "Prioritize billing.",
      guidance_updated_at: "2024-04-03T12:00:00Z",
    },
  });
  expect((textarea as HTMLTextAreaElement).value).toBe("Prioritize billing.");
  expect(editor.getByText(/^Updated /)).toBeTruthy();

  fireEvent.change(textarea, { target: { value: "🌱".repeat(2001) } });
  expect(editor.getByText("2,001 / 2,000")).toBeTruthy();
  expect(save.disabled).toBe(true);
  fireEvent.submit(save.form!);
  expect(socket.send).not.toHaveBeenCalled();

  const text = "🌱".repeat(2000);
  fireEvent.change(textarea, { target: { value: text } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  expect(socket.latestRequest()).toMatchObject({
    type: "SET_GUIDANCE",
    input: { text },
  });
  socket.receive({
    type: "SETTINGS_UPDATE",
    seq: 3,
    settings: {
      ...snapshot.settings,
      guidance: text,
      guidance_updated_at: "2024-04-03T12:01:00Z",
    },
  });
  await act(async () =>
    socket.receive({
      type: "ACK",
      seq: 4,
      requestId: socket.latestRequest().requestId,
    }),
  );
  expect(editor.getByText("Guidance saved.")).toBeTruthy();
});

it("locks the timezone draft until its save is acknowledged", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const account = within(
    screen.getByRole("region", { name: "Workspace and account" }),
  );
  const input = account.getByLabelText(
    "Workspace timezone",
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Europe/Tallinn" } });
  fireEvent.click(account.getByRole("button", { name: "Save timezone" }));
  const socket = TestSocket.current;
  const request = socket.latestRequest();
  expect(request).toMatchObject({
    type: "SET_TIMEZONE",
    input: { timezone: "Europe/Tallinn" },
  });
  expect(input.disabled).toBe(true);
  socket.receive({
    type: "SETTINGS_UPDATE",
    seq: 2,
    settings: { ...snapshot.settings, timezone: "Europe/Tallinn" },
  });
  expect(input.disabled).toBe(true);
  await act(async () =>
    socket.receive({ type: "ACK", seq: 3, requestId: request.requestId }),
  );
  expect(input.disabled).toBe(false);
  expect(input.value).toBe("Europe/Tallinn");
});

it("locks the new project name until creation succeeds or fails", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const projects = within(screen.getByRole("region", { name: "Projects" }));
  const input = projects.getByLabelText("New project name") as HTMLInputElement;
  const submit = projects.getByRole("button", { name: "Create project" });
  fireEvent.change(input, { target: { value: "Release planning" } });
  fireEvent.click(submit);
  const socket = TestSocket.current;
  const request = socket.latestRequest();
  expect(request).toMatchObject({
    type: "CREATE_PROJECT",
    input: { name: "Release planning" },
  });
  expect(input.disabled).toBe(true);
  await act(async () =>
    socket.receive({
      type: "ERROR",
      seq: 2,
      requestId: request.requestId,
      error: { code: "invalid_input", message: "Try a different name." },
    }),
  );
  expect(input.disabled).toBe(false);
  expect(input.value).toBe("Release planning");

  fireEvent.change(input, { target: { value: "Launch planning" } });
  fireEvent.click(submit);
  const retry = socket.latestRequest();
  expect(input.disabled).toBe(true);
  socket.receive({
    type: "PROJECT_UPSERT",
    seq: 3,
    project: { ...project, id: "launch", name: "Launch planning", sort: 1 },
  });
  await act(async () =>
    socket.receive({ type: "ACK", seq: 4, requestId: retry.requestId }),
  );
  expect(input.disabled).toBe(false);
  expect(input.value).toBe("");
});

it("shows the token and MCP config once and lists only metadata afterward", async () => {
  await openWorkspace();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal(
    "navigator",
    Object.assign({}, navigator, { clipboard: { writeText } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  let settings = within(screen.getByRole("dialog", { name: "Settings" }));
  await settings.findByText("No API tokens yet.");
  fireEvent.change(settings.getByLabelText("Label"), {
    target: { value: "Build reporter" },
  });
  fireEvent.change(settings.getByLabelText("Scope"), {
    target: { value: "steer" },
  });
  fireEvent.change(settings.getByLabelText("Default project"), {
    target: { value: project.id },
  });
  fireEvent.click(settings.getByRole("button", { name: "Create token" }));
  const socket = TestSocket.current;
  expect(socket.latestRequest()).toMatchObject({
    type: "CREATE_TOKEN",
    input: {
      label: "Build reporter",
      scope: "steer",
      default_project_id: project.id,
    },
  });
  const metadata = {
    id: "token-id",
    label: "Build reporter",
    scope: "steer",
    default_project_id: project.id,
    last_used_at: null,
    created_at: goal.created_at,
  } as const;
  const token = "example-plaintext-for-test";
  await act(async () =>
    socket.receive({
      type: "ACK",
      seq: 2,
      requestId: socket.latestRequest().requestId,
      createdToken: { ...metadata, token },
    }),
  );
  expect(settings.getByDisplayValue(token)).toBeTruthy();
  const config = settings.getByLabelText(
    /Claude Code MCP config/,
  ) as HTMLTextAreaElement;
  expect(JSON.parse(config.value).mcpServers.heed).toMatchObject({
    headers: { Authorization: `Bearer ${token}` },
  });
  fireEvent.click(settings.getByRole("button", { name: "Copy token" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
  await settings.findByText("Token copied.");
  fireEvent.click(settings.getByRole("button", { name: "Done" }));
  expect(settings.queryByDisplayValue(token)).toBeNull();
  expect(settings.getByText(metadata.label)).toBeTruthy();

  fireEvent.click(settings.getByRole("button", { name: "Close" }));
  fetchSession.mockImplementation(async () => Response.json([metadata]));
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  settings = within(screen.getByRole("dialog", { name: "Settings" }));
  expect(await settings.findByText(metadata.label)).toBeTruthy();
  expect(settings.queryByDisplayValue(token)).toBeNull();
  expect(settings.queryByLabelText(/Claude Code MCP config/)).toBeNull();
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

const taggedProject = { ...project, id: "engineering", name: "Engineering" };
const taggedBacklogItem = {
  ...goal,
  project_id: taggedProject.id,
  scheduled_on: null,
  tags: '["platform"]',
};
const untaggedBacklogItem = {
  ...goal,
  id: "untagged",
  title: "Triage feedback",
  scheduled_on: null,
};

async function openFilteredBacklog() {
  await openWorkspace();
  TestSocket.current.receive({
    ...snapshot,
    seq: 2,
    projects: [project, taggedProject],
    items: [taggedBacklogItem, untaggedBacklogItem],
  });
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  fireEvent.click(stream.getByRole("button", { name: "Inbox 1" }));
  const filter = () =>
    stream.getByRole<HTMLSelectElement>("combobox", {
      name: "Filter backlog by tag",
    });
  fireEvent.change(filter(), { target: { value: "platform" } });
  expect(
    stream.queryByRole("button", { name: untaggedBacklogItem.title }),
  ).toBeNull();
  return { stream, filter };
}

it("can clear the last backlog tag while a keyboard move is saving", async () => {
  const { stream, filter } = await openFilteredBacklog();
  fireEvent.keyDown(
    stream.getByRole("button", { name: `Move ${taggedBacklogItem.title}` }),
    { key: "ArrowLeft" },
  );
  const later = stream.getByRole("region", { name: "Later" });
  expect(
    within(later).getByRole("button", { name: taggedBacklogItem.title }),
  ).toBeTruthy();
  expect(filter().value).toBe("platform");
  fireEvent.change(filter(), { target: { value: "" } });
  expect(
    stream.getByRole("button", { name: untaggedBacklogItem.title }),
  ).toBeTruthy();
});

it.each([
  ["removes the tagged item", { type: "ITEM_REMOVE", item_id: goal.id }],
  [
    "replaces the selected tag",
    { type: "ITEM_UPSERT", item: { ...taggedBacklogItem, tags: '["urgent"]' } },
  ],
  [
    "hides the tagged project",
    { type: "PROJECT_UPSERT", project: { ...taggedProject, hidden: 1 } },
  ],
] as const)(
  "can clear the backlog filter when a live update %s",
  async (_, update) => {
    const { stream, filter } = await openFilteredBacklog();
    TestSocket.current.receive({ ...update, seq: 3 });
    expect(filter().value).toBe("platform");
    expect(stream.getByText("No backlog items match this tag.")).toBeTruthy();
    fireEvent.change(filter(), { target: { value: "" } });
    expect(
      stream.getByRole("button", { name: untaggedBacklogItem.title }),
    ).toBeTruthy();
  },
);

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
