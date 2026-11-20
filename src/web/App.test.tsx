import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
  const view = render(<App registry={registry} />);
  await screen.findByRole("heading", { name: "Horizon Stream" });
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
