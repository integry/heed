import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
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
  const previousSocket = TestSocket.current;
  const view = render(<App registry={registry} />);
  await waitFor(() => expect(TestSocket.current).not.toBe(previousSocket));
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
  render(<App />);
  await screen.findByRole("heading", { name: "Horizon Stream" });
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
