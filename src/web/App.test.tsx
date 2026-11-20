import {
  act,
  cleanup,
  createEvent,
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
import { cellPoint, RADAR_BANDS, type Cell } from "./radar-geometry";
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
  window.history.replaceState(null, "", "/");
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
  readWorkspaceApi: (path: string) => Response | Promise<Response> = () =>
    Response.json([]),
) {
  fetchSession.mockImplementation(async (path: string) =>
    path === "/api/me"
      ? Response.json({ workspaceId: "default", email: "person@example.test" })
      : readWorkspaceApi(path),
  );
  const previousSocket = TestSocket.current;
  const view = render(<App registry={registry} />);
  await waitFor(() => expect(TestSocket.current).not.toBe(previousSocket));
  TestSocket.current.receive(initialSnapshot);
  return view;
}

const notificationItem = {
  ...goal,
  id: "older-item",
  title: "Review payment alerts",
  status: "done",
  completed_at: "2024-03-01T12:00:00Z",
} as const;
const inspectorRegion = { name: "Inspector" };

function missingItem() {
  return Response.json(
    { error: { code: "not_found", message: "Item not found" } },
    { status: 404 },
  );
}

async function openNotificationItem(lookup: () => Response) {
  window.history.replaceState(null, "", `/?item=${notificationItem.id}`);
  await openWorkspace(undefined, snapshot, (path) =>
    path === `/api/items/${notificationItem.id}` ? lookup() : Response.json([]),
  );
  return TestSocket.current;
}

it("discards the notification fallback when a reopened item enters the canvas", async () => {
  const lookup = vi
    .fn(missingItem)
    .mockReturnValueOnce(Response.json(notificationItem));
  const socket = await openNotificationItem(lookup);
  await screen.findByDisplayValue(notificationItem.title);

  const reopened = {
    ...notificationItem,
    title: "Review new payment alerts",
    status: "queued",
    completed_at: null,
  } as const;
  socket.receive({ type: "ITEM_UPSERT", seq: 2, item: reopened });
  expect(screen.getByDisplayValue(reopened.title)).toBeTruthy();
  expect(lookup).toHaveBeenCalledTimes(1);

  socket.receive({ type: "ITEM_REMOVE", seq: 3, item_id: reopened.id });
  expect(screen.queryByRole("complementary", inspectorRegion)).toBeNull();
  await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("complementary", inspectorRegion)).toBeNull();
});

it("closes the notification inspector when an off-canvas item is removed", async () => {
  const lookup = vi
    .fn(missingItem)
    .mockReturnValueOnce(Response.json(notificationItem));
  const socket = await openNotificationItem(lookup);
  await screen.findByDisplayValue(notificationItem.title);

  socket.receive({ type: "ITEM_REMOVE", seq: 2, item_id: notificationItem.id });
  expect(screen.queryByRole("complementary", inspectorRegion)).toBeNull();
  await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("complementary", inspectorRegion)).toBeNull();
});

it("ignores a notification lookup still parsing its response when the item is removed", async () => {
  const response = new Response();
  let finishBody!: () => void;
  const json = vi.spyOn(response, "json").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishBody = () => resolve(notificationItem);
      }),
  );
  const lookup = vi.fn(missingItem).mockReturnValueOnce(response);
  const socket = await openNotificationItem(lookup);
  await waitFor(() => expect(json).toHaveBeenCalledOnce());

  socket.receive({ type: "ITEM_REMOVE", seq: 2, item_id: notificationItem.id });
  await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  await act(async () => finishBody());
  expect(screen.queryByRole("complementary", inspectorRegion)).toBeNull();
});

it.each([false, true])(
  "revalidates an off-canvas notification item after resync (exists: %s)",
  async (exists) => {
    const lookup = vi
      .fn(() =>
        exists
          ? Response.json({ ...notificationItem, title: "Updated alerts" })
          : missingItem(),
      )
      .mockReturnValueOnce(Response.json(notificationItem));
    const socket = await openNotificationItem(lookup);
    await screen.findByDisplayValue(notificationItem.title);

    socket.receive({ type: "ITEM_UPSERT", seq: 3, item: goal });
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "GET_SNAPSHOT" }),
    );
    socket.receive({ ...snapshot, seq: 4 });
    expect(screen.queryByRole("complementary", inspectorRegion)).toBeNull();
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    if (exists)
      expect(await screen.findByDisplayValue("Updated alerts")).toBeTruthy();
    else
      expect(screen.queryByRole("complementary", inspectorRegion)).toBeNull();
  },
);

it("cross-highlights nested and banded rows, and hides them when the project is toggled", async () => {
  localStorage.setItem("heed.lens", "list");
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

  fireEvent.click(stream.getByRole("button", { name: `Expand ${goal.title}` }));
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
  // Needs me keeps ancestors of attention items visible in the lens.
  expect(radar.queryByRole("button", { name: tomorrow.title })).toBeNull();
  fireEvent.click(radar.getByRole("button", { name: goal.title }));
  expect(radar.getByRole("button", { name: child.title })).toBeTruthy();
});

const completedGoal = {
  ...goal,
  status: "done",
  completed_at: "2024-04-03T11:00:00Z",
} as const;

function startRadarRingDrop(
  bubble: HTMLElement,
  overview: boolean,
  band: Cell["band"] = "backlog",
) {
  const scene = bubble.closest(".radar-node")!.parentElement!;
  Object.defineProperty(scene, "getScreenCTM", {
    configurable: true,
    value: () => null,
  });
  const [clientX, clientY] = bubble
    .parentElement!.getAttribute("transform")!
    .slice("translate(".length, -1)
    .split(",")
    .map(Number);
  const target = overview
    ? cellPoint({ band, sector: 0, sectors: 1 }, { angle: 0.5, radius: 0.5 })
    : { x: 175 + RADAR_BANDS.indexOf(band) * 150, y: 716 };
  const pointer = { pointerId: 1, isPrimary: true, button: 0 };
  const destination = { ...pointer, clientX: target.x, clientY: target.y };
  fireEvent.pointerDown(bubble, { ...pointer, clientX, clientY });
  fireEvent.pointerMove(bubble, destination);
  return () => fireEvent.pointerUp(bubble, destination);
}

it.each(["goal", "overview", "new ancestor schedule", "no ancestor schedule"])(
  "checks inheritance before applying a Radar Backlog drop (%s)",
  async (scenario) => {
    const overview = scenario === "overview";
    const initiallyUnscheduled = scenario.includes("ancestor schedule");
    const parent = overview
      ? completedGoal
      : {
          ...goal,
          scheduled_on: initiallyUnscheduled ? null : goal.scheduled_on,
        };
    const task = {
      ...child,
      scheduled_on: initiallyUnscheduled ? goal.scheduled_on : null,
    };
    await openWorkspace(undefined, { ...snapshot, items: [parent, task] });
    const radar = within(screen.getByRole("region", { name: "Radar" }));
    if (overview)
      fireEvent.click(
        radar.getByRole("checkbox", { name: "Show completed ghosts" }),
      );
    else fireEvent.click(radar.getByRole("button", { name: parent.title }));

    const release = startRadarRingDrop(
      radar.getByRole("button", { name: task.title }),
      overview,
    );
    const socket = TestSocket.current;
    expect(socket.send).not.toHaveBeenCalled();
    if (scenario === "new ancestor schedule")
      socket.receive({ type: "ITEM_UPSERT", seq: 2, item: goal });
    release();

    const rejection = /it would inherit a schedule from an ancestor/;
    if (scenario === "no ancestor schedule") {
      expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
        type: "UPDATE_ITEM",
        input: { item_id: task.id, scheduled_on: null },
      });
      expect(radar.queryByText(rejection)).toBeNull();
    } else {
      expect(socket.send).not.toHaveBeenCalled();
      expect(radar.getByText(rejection)).toBeTruthy();
    }
  },
);

it.each(["overview", "goal"])(
  "checks the resulting Radar Backlog band in the %s view",
  async (view) => {
    const overview = view === "overview";
    const parent = { ...goal, scheduled_on: null };
    const timed = {
      time_type: "fixed",
      time_at: "2024-04-10T12:00:00Z",
    } as const;
    const task = {
      ...child,
      scheduled_on: goal.scheduled_on,
      ...(overview ? { parent_id: null, depth: 1 } : {}),
    };
    const timedTask = { ...task, ...timed, id: "timed", title: "Vendor call" };
    const activeTask = {
      ...task,
      status: "active",
      id: "active",
      title: "Live rollout",
    } as const;
    const tasks = [task, timedTask, activeTask];
    await openWorkspace(undefined, {
      ...snapshot,
      items: overview ? tasks : [parent, ...tasks],
    });
    const radar = within(screen.getByRole("region", { name: "Radar" }));
    if (!overview)
      fireEvent.click(radar.getByRole("button", { name: parent.title }));
    const socket = TestSocket.current;
    const startDrop = (title: string) =>
      startRadarRingDrop(radar.getByRole("button", { name: title }), overview);

    startDrop(timedTask.title)();
    expect(
      radar.getByText(
        `${timedTask.title} can’t move to Backlog because it still has a time set.`,
      ),
    ).toBeTruthy();
    startDrop(activeTask.title)();
    expect(
      radar.getByText(
        `${activeTask.title} can’t move to Backlog because it is active.`,
      ),
    ).toBeTruthy();

    const release = startDrop(task.title);
    socket.receive({
      type: "ITEM_UPSERT",
      seq: 2,
      item: { ...task, ...timed },
    });
    release();
    expect(
      radar.getByText(
        `${task.title} can’t move to Backlog because it still has a time set.`,
      ),
    ).toBeTruthy();
    expect(socket.send).not.toHaveBeenCalled();

    socket.receive({ type: "ITEM_UPSERT", seq: 3, item: task });
    startDrop(task.title)();
    expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
      type: "UPDATE_ITEM",
      input: {
        item_id: task.id,
        scheduled_on: null,
        ...(overview
          ? { layout_pos: { radar: { angle: 0.5, radius: 0.5 } } }
          : {}),
      },
    });
    expect(radar.queryByText(/can’t move to Backlog/)).toBeNull();
  },
);

it.each(["overview", "goal"])(
  "checks future Radar destinations in the %s view using the state at release",
  async (view) => {
    const overview = view === "overview";
    const task = {
      ...child,
      scheduled_on: goal.scheduled_on,
      ...(overview ? { parent_id: null, depth: 1 } : {}),
    };
    const overdue = {
      ...task,
      id: "overdue",
      title: "Vendor call",
      time_type: "fixed",
      time_at: "2024-04-02T12:00:00Z",
    } as const;
    await openWorkspace(undefined, {
      ...snapshot,
      items: overview ? [task, overdue] : [goal, task, overdue],
    });
    const radar = within(screen.getByRole("region", { name: "Radar" }));
    if (!overview)
      fireEvent.click(radar.getByRole("button", { name: goal.title }));
    const socket = TestSocket.current;
    const startDrop = (title: string, target: Cell["band"]) =>
      startRadarRingDrop(
        radar.getByRole("button", { name: title }),
        overview,
        target,
      );

    startDrop(overdue.title, "this-week")();
    expect(
      radar.getByText(
        `${overdue.title} can’t move to This week because its time keeps it in Today.`,
      ),
    ).toBeTruthy();

    const release = startDrop(task.title, "later");
    socket.receive({
      type: "ITEM_UPSERT",
      seq: 2,
      item: { ...task, status: "active" },
    });
    release();
    expect(
      radar.getByText(
        `${task.title} can’t move to Later because it is active.`,
      ),
    ).toBeTruthy();
    expect(socket.send).not.toHaveBeenCalled();

    socket.receive({ type: "ITEM_UPSERT", seq: 3, item: task });
    for (const [target, date] of [
      ["this-week", "2024-04-04"],
      ["later", "2024-04-08"],
      ["today", "2024-04-03"],
    ] as const) {
      socket.send.mockClear();
      startDrop(task.title, target)();
      expect(socket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
        type: "UPDATE_ITEM",
        input: { item_id: task.id, scheduled_on: date },
      });
      expect(radar.queryByText(/can’t move to/)).toBeNull();
    }
  },
);

it("checks a Radar drop after a time becomes due between clock ticks", async () => {
  const clock = vi.mocked(Date.now);
  clock.mockReturnValue(Date.parse("2024-04-03T23:59:55Z"));
  const task = {
    ...goal,
    scheduled_on: null,
    time_type: "fixed",
    time_at: "2024-04-04T00:00:07Z",
  } as const;
  await openWorkspace(undefined, { ...snapshot, items: [task] });
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  const release = startRadarRingDrop(
    radar.getByRole("button", { name: task.title }),
    true,
    "later",
  );
  clock.mockReturnValue(Date.parse("2024-04-04T00:00:08Z"));
  release();
  expect(
    radar.getByText(
      `${task.title} can’t move to Later because its time keeps it in Today.`,
    ),
  ).toBeTruthy();
  expect(TestSocket.current.send).not.toHaveBeenCalled();
});

it.each(["Radar", "List"])(
  "reveals a selected %s child through a hidden completed ancestor",
  async (source) => {
    const middle = {
      ...completedGoal,
      id: "middle",
      parent_id: goal.id,
      title: "Completed milestone",
    };
    const task = { ...child, parent_id: middle.id, depth: 3 };
    await openWorkspace(undefined, {
      ...snapshot,
      items: [goal, middle, task],
    });
    const radar = within(screen.getByRole("region", { name: "Radar" }));
    fireEvent.click(
      radar.getByRole("checkbox", { name: "Show completed ghosts" }),
    );
    const lens = screen.getByRole("combobox", { name: "Lens" });
    if (source === "List") {
      fireEvent.change(lens, { target: { value: "list" } });
      const list = within(screen.getByRole("region", { name: "List" }));
      fireEvent.click(
        list.getByRole("button", { name: new RegExp(task.title) }),
      );
      fireEvent.change(lens, { target: { value: "radar" } });
    } else {
      const stream = within(
        screen.getByRole("region", { name: "Horizon Stream" }),
      );
      fireEvent.click(stream.getByRole("button", { name: task.title }));
    }
    expect(radar.queryByRole("button", { name: middle.title })).toBeNull();
    expect(radar.getByLabelText(`Items in ${goal.title}`)).toBeTruthy();
    expect(
      radar
        .getByRole("button", { name: task.title })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  },
);

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

it.each([false, true])(
  "carries Radar's completed ghost visibility (%s) into Dependencies",
  async (showGhosts) => {
    const finished = {
      ...child,
      id: "finished",
      title: "Trace checkout errors",
      status: "done" as const,
      completed_at: "2024-04-03T11:00:00Z",
    };
    const external = {
      ...finished,
      id: "external",
      parent_id: null,
      depth: 1,
      title: "Confirm vendor capacity",
    };
    await openWorkspace(undefined, {
      ...snapshot,
      items: [...snapshot.items, finished, external],
      dependencies: [
        { item_id: child.id, blocked_by_id: finished.id },
        { item_id: tomorrow.id, blocked_by_id: external.id },
        { item_id: tomorrow.id, blocked_by_id: child.id },
      ],
    });
    const radar = within(screen.getByRole("region", { name: "Radar" }));
    if (!showGhosts) {
      fireEvent.click(
        radar.getByRole("checkbox", { name: "Show completed ghosts" }),
      );
    }
    fireEvent.click(radar.getByRole("button", { name: goal.title }));
    fireEvent.click(radar.getByRole("button", { name: "Dependencies" }));
    const graph = within(
      screen.getByRole("region", {
        name: `Dependency graph for ${goal.title}`,
      }),
    );

    expect(graph.getByText(child.title)).toBeTruthy();
    expect(graph.getByText(tomorrow.title)).toBeTruthy();
    expect(
      graph.getByRole("button", {
        name: `${child.title} blocks ${tomorrow.title}`,
      }),
    ).toBeTruthy();
    expect(Boolean(graph.queryByText(finished.title))).toBe(showGhosts);
    expect(Boolean(graph.queryByText(external.title))).toBe(showGhosts);
    for (const [blocker, blocked] of [
      [finished, child],
      [external, tomorrow],
    ]) {
      expect(
        Boolean(
          graph.queryByRole("button", {
            name: `${blocker.title} blocks ${blocked.title}`,
          }),
        ),
      ).toBe(showGhosts);
    }
  },
);

it("opens the goal graph from the inspector and highlights the leading blocker", async () => {
  const upstream = {
    ...goal,
    id: "vendor",
    title: "Confirm vendor capacity",
    status: "active" as const,
    agent_name: "Vendor agent",
    last_heartbeat_at: "2024-04-03T11:55:00Z",
  };
  await openWorkspace(undefined, {
    ...snapshot,
    items: [...snapshot.items, upstream],
    dependencies: [
      { item_id: child.id, blocked_by_id: upstream.id },
      { item_id: tomorrow.id, blocked_by_id: child.id },
    ],
  });
  const inspector = inspect(goal.title);
  fireEvent.click(
    inspector.getByRole("button", { name: "Open dependency graph" }),
  );
  const graph = within(
    screen.getByRole("region", { name: `Dependency graph for ${goal.title}` }),
  );
  const vendor = graph.getByRole("button", {
    name: /Confirm vendor capacity.*Live.*Vendor agent.*External.*Blocks 2 items/,
  });
  expect(vendor.parentElement?.dataset.blocker).toBe("true");
  expect(vendor.parentElement?.dataset.external).toBe("true");
  expect(
    graph.getByRole("button", { name: /Review retry policy.*Needs input/ })
      .parentElement?.dataset.blocker,
  ).toBe("false");
  fireEvent.click(vendor);
  expect(vendor.getAttribute("aria-pressed")).toBe("true");
  expect(localStorage.getItem("heed.lens")).toBe("dependencies");

  fireEvent.click(screen.getByRole("button", { name: "Change goal" }));
  expect(screen.getByText("Pick a goal to see its dependencies.")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Goal" }), {
    target: { value: goal.id },
  });
  expect(
    screen.getByRole("region", { name: `Dependency graph for ${goal.title}` }),
  ).toBeTruthy();
});

it("saves node drags, removes selected edges, and shows server cycle errors inline", async () => {
  await openWorkspace();
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  fireEvent.click(radar.getByRole("button", { name: goal.title }));
  fireEvent.click(radar.getByRole("button", { name: "Dependencies" }));
  const lens = within(screen.getByRole("region", { name: "Dependencies" }));
  const graph = within(
    lens.getByRole("region", { name: `Dependency graph for ${goal.title}` }),
  );
  const socket = TestSocket.current;
  const handle = graph.getByRole("button", {
    name: `Connect ${child.title} as a blocker`,
  });
  const target = graph.getByRole("button", {
    name: new RegExp(`^${tomorrow.title}\\s*Queued$`),
  });
  const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => target,
  });
  const pointer = {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientY: 100,
  };
  try {
    fireEvent.pointerDown(handle, { ...pointer, clientX: 50 });
    fireEvent.pointerMove(handle, { ...pointer, clientX: 200 });
    expect(socket.send).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { ...pointer, clientX: 200 });
  } finally {
    if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
  }

  const dependency = { item_id: tomorrow.id, blocked_by_id: child.id };
  expect(socket.latestRequest()).toMatchObject({
    type: "SET_DEPENDENCY",
    input: { ...dependency, action: "add" },
  });
  socket.receive({ type: "DEPENDENCY_ADD", seq: 2, dependency });
  socket.receive({
    type: "ACK",
    seq: 3,
    requestId: socket.latestRequest().requestId,
  });
  const connection = graph.getByRole("button", {
    name: `${child.title} blocks ${tomorrow.title}`,
  });
  await waitFor(() => expect(handle).toHaveProperty("disabled", false));

  fireEvent.click(
    graph.getByRole("button", {
      name: `Connect ${tomorrow.title} as a blocker`,
    }),
  );
  fireEvent.click(
    graph.getByRole("button", {
      name: new RegExp(`^${child.title}\\s*Needs input`),
    }),
  );
  expect(socket.latestRequest()).toMatchObject({
    type: "SET_DEPENDENCY",
    input: { item_id: child.id, blocked_by_id: tomorrow.id, action: "add" },
  });
  socket.receive({
    type: "ERROR",
    seq: 4,
    requestId: socket.latestRequest().requestId,
    error: {
      code: "invalid_input",
      message: "Dependency would create a cycle.",
    },
  });
  expect((await lens.findByRole("alert")).textContent).toBe(
    "Dependency would create a cycle.",
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);

  fireEvent.click(connection);
  fireEvent.click(lens.getByRole("button", { name: "Remove dependency" }));
  expect(socket.latestRequest()).toMatchObject({
    type: "SET_DEPENDENCY",
    input: { ...dependency, action: "remove" },
  });
  socket.receive({ type: "DEPENDENCY_REMOVE", seq: 5, dependency });
  await act(async () =>
    socket.receive({
      type: "ACK",
      seq: 6,
      requestId: socket.latestRequest().requestId,
    }),
  );
  expect(
    graph.queryByRole("button", {
      name: `${child.title} blocks ${tomorrow.title}`,
    }),
  ).toBeNull();
  expect(lens.queryByRole("alert")).toBeNull();
});

it.each([
  "Escape",
  "Escape outside the graph",
  "pointer cancel",
  "lost pointer capture",
])(
  "clears a connection drag on %s and ignores its release and click",
  async (cancel) => {
    localStorage.setItem("heed.lens", "dependencies");
    await openWorkspace();
    fireEvent.change(screen.getByRole("combobox", { name: "Goal" }), {
      target: { value: goal.id },
    });
    const graph = screen.getByRole("region", {
      name: `Dependency graph for ${goal.title}`,
    });
    const handle = within(graph).getByRole("button", {
      name: `Connect ${child.title} as a blocker`,
    });
    const target = within(graph).getByRole("button", {
      name: new RegExp(`^${tomorrow.title}`),
    });
    const hitTest = Object.getOwnPropertyDescriptor(
      document,
      "elementFromPoint",
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });
    const pointer = { pointerId: 1, button: 0, clientY: 100 };
    try {
      fireEvent.pointerDown(handle, { ...pointer, clientX: 50 });
      fireEvent.pointerMove(handle, { ...pointer, clientX: 200 });
      expect(graph.querySelector(".dependency-preview")).toBeTruthy();
      if (cancel === "Escape") fireEvent.keyDown(handle, { key: "Escape" });
      else if (cancel === "Escape outside the graph")
        fireEvent.keyDown(document.body, { key: "Escape" });
      else if (cancel === "pointer cancel")
        fireEvent.pointerCancel(handle, pointer);
      else fireEvent.lostPointerCapture(handle, pointer);
      expect(graph.querySelector(".dependency-preview")).toBeNull();
      fireEvent.pointerUp(handle, { ...pointer, clientX: 200 });
      fireEvent.click(handle, { detail: 1 });
      expect(handle.getAttribute("aria-pressed")).toBe("false");
      expect(TestSocket.current.send).not.toHaveBeenCalled();

      fireEvent.pointerDown(handle, { ...pointer, clientX: 50 });
      fireEvent.pointerUp(handle, { ...pointer, clientX: 50 });
      fireEvent.click(handle, { detail: 1 });
      expect(handle.getAttribute("aria-pressed")).toBe("true");
    } finally {
      if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
      else Reflect.deleteProperty(document, "elementFromPoint");
    }
  },
);

it.each([
  {
    action: "add",
    navigation: "switching lenses",
    navigateFirst: true,
    seq: 2,
  },
  {
    action: "remove",
    navigation: "changing goals",
    navigateFirst: true,
    seq: 3,
  },
  {
    action: "add",
    navigation: "switching lenses",
    navigateFirst: false,
    seq: 2,
  },
  {
    action: "add",
    navigation: "switching lenses",
    navigateFirst: true,
    seq: 2,
    disconnect: true,
  },
])(
  "keeps an $action failure visible when $navigation (navigate before reply: $navigateFirst, connection lost: $disconnect)",
  async ({ action, navigation, navigateFirst, seq, disconnect }) => {
    localStorage.setItem("heed.lens", "dependencies");
    const nextGoal = { ...goal, id: "next-goal", title: "Incident response" };
    await openWorkspace(undefined, {
      ...snapshot,
      items: [...snapshot.items, nextGoal],
      dependencies: [{ item_id: tomorrow.id, blocked_by_id: child.id }],
    });
    const pickGoal = (id: string) =>
      fireEvent.change(screen.getByRole("combobox", { name: "Goal" }), {
        target: { value: id },
      });
    pickGoal(goal.id);
    const lens = within(screen.getByRole("region", { name: "Dependencies" }));
    const graph = within(
      lens.getByRole("region", { name: `Dependency graph for ${goal.title}` }),
    );
    if (action === "add") {
      fireEvent.click(
        graph.getByRole("button", {
          name: `Connect ${tomorrow.title} as a blocker`,
        }),
      );
      fireEvent.click(
        graph.getByRole("button", {
          name: new RegExp(child.title + "\\s*Needs input"),
        }),
      );
    } else {
      fireEvent.click(
        graph.getByRole("button", {
          name: `${child.title} blocks ${tomorrow.title}`,
        }),
      );
      fireEvent.click(lens.getByRole("button", { name: "Remove dependency" }));
    }
    const socket = TestSocket.current;
    const request = socket.latestRequest();
    expect(request).toMatchObject({
      type: "SET_DEPENDENCY",
      input: { action },
    });
    function navigate() {
      if (navigation === "changing goals") {
        fireEvent.click(lens.getByRole("button", { name: "Change goal" }));
        pickGoal(nextGoal.id);
      } else {
        fireEvent.change(screen.getByRole("combobox", { name: "Lens" }), {
          target: { value: "list" },
        });
      }
    }
    if (navigateFirst) navigate();
    const rejection =
      action === "add"
        ? "Dependency would create a cycle."
        : "The dependency could not be removed.";
    await act(async () => {
      if (disconnect) {
        socket.close();
        return;
      }
      socket.receive({
        type: "ERROR",
        seq,
        requestId: request.requestId,
        error: { code: "invalid_input", message: rejection },
      });
    });
    const message = disconnect
      ? "Connection lost while saving. Check the workspace after reconnecting."
      : rejection;
    if (!navigateFirst) {
      expect(lens.getByRole("alert").textContent).toBe(message);
      navigate();
    }
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe(message);
    expect(error.closest(".error-banner")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

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
  localStorage.setItem("heed.lens", "list");
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
  localStorage.setItem("heed.lens", "list");
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
  localStorage.setItem("heed.lens", "list");
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
    fireEvent.pointerUp(handle, { ...pointer, clientY: 45 });
    expect(socket.send).not.toHaveBeenCalled();

    const press = createEvent.pointerDown(handle, { ...pointer, clientY: 100 });
    const movement = createEvent.pointerMove(handle, {
      ...pointer,
      clientY: 45,
    });
    Object.defineProperty(movement, "timeStamp", {
      value: press.timeStamp + 500,
    });
    fireEvent(handle, press);
    fireEvent(handle, movement);
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

it("preserves existing tag values and backlog membership when adding a tag", async () => {
  await openWorkspace();
  const existing = ["research, development", "  platform  ", "", "two\nlines"];
  const item = {
    ...goal,
    scheduled_on: null,
    tags: JSON.stringify(existing),
  };
  const socket = TestSocket.current;
  socket.receive({ ...snapshot, seq: 2, items: [item] });
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  fireEvent.click(stream.getByRole("button", { name: "Inbox 1" }));
  const filter = stream.getByRole<HTMLSelectElement>("combobox", {
    name: "Filter backlog by tag",
  });
  fireEvent.change(filter, { target: { value: existing[0] } });

  const inspector = inspect(item.title);
  fireEvent.change(inspector.getByRole("textbox", { name: "New tag" }), {
    target: { value: "urgent" },
  });
  fireEvent.click(inspector.getByRole("button", { name: "Add tag" }));
  fireEvent.click(inspector.getByRole("button", { name: "Save details" }));

  const tags = [...existing, "urgent"];
  const request = socket.latestRequest();
  expect(request).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: item.id, tags },
  });
  expect(
    inspector.getByRole("textbox", { name: "New tag" }).matches(":disabled"),
  ).toBe(true);
  socket.receive({
    type: "ITEM_UPSERT",
    seq: 3,
    item: { ...item, tags: JSON.stringify(tags) },
  });
  await act(async () =>
    socket.receive({ type: "ACK", requestId: request.requestId, seq: 4 }),
  );
  expect(filter.value).toBe(existing[0]);
  expect(stream.getByRole("button", { name: item.title })).toBeTruthy();
  expect(inspector.getByText("urgent")).toBeTruthy();
  expect(inspector.queryByRole("button", { name: "Save details" })).toBeNull();
});

it("prevents an outdated tag draft from replacing newer tags", async () => {
  await openWorkspace();
  const originalTag = "research, development";
  const item = { ...goal, tags: JSON.stringify([originalTag, "retired"]) };
  const socket = TestSocket.current;
  socket.receive({ ...snapshot, seq: 2, items: [item] });
  const inspector = inspect(item.title);
  fireEvent.click(
    inspector.getByRole("button", { name: "Remove tag retired" }),
  );
  socket.receive({
    type: "ITEM_UPSERT",
    seq: 3,
    item: { ...item, tags: JSON.stringify([originalTag, "retired", "remote"]) },
  });
  fireEvent.click(inspector.getByRole("button", { name: "Save details" }));
  expect(socket.send).not.toHaveBeenCalled();

  fireEvent.click(inspector.getByRole("button", { name: "Reload tags" }));
  fireEvent.click(
    inspector.getByRole("button", { name: "Remove tag retired" }),
  );
  fireEvent.click(inspector.getByRole("button", { name: "Save details" }));
  const request = socket.latestRequest();
  expect(request).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: item.id, tags: [originalTag, "remote"] },
  });
  await act(async () =>
    socket.receive({
      type: "ERROR",
      requestId: request.requestId,
      seq: 4,
      error: { code: "invalid_input", message: "Couldn’t save tags." },
    }),
  );
  expect(
    inspector.queryByRole("button", { name: "Remove tag retired" }),
  ).toBeNull();
  expect(
    inspector.getByRole<HTMLButtonElement>("button", { name: "Save details" })
      .disabled,
  ).toBe(false);
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

it("selects Treemap tiles, zooms into parents and returns through their breadcrumbs", async () => {
  const finished = {
    ...child,
    id: "finished",
    title: "Shipped work",
    status: "done",
    completed_at: "2024-04-03T11:00:00Z",
  } as const;
  const parent = { ...goal, progress: { done: 1, total: 3 } };
  await openWorkspace(undefined, {
    ...snapshot,
    items: [parent, child, tomorrow, finished],
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Lens" }), {
    target: { value: "treemap" },
  });

  const lens = within(screen.getByRole("region", { name: "Treemap" }));
  const overview = lens.getByRole("button", { name: goal.title });
  expect(overview.getAttribute("aria-description")).toContain(
    "1 of 3 complete",
  );
  expect(
    overview.parentElement
      ?.querySelector(".treemap-rollup")
      ?.getAttribute("data-ring"),
  ).toBe("handoff");
  expect(
    lens
      .getByRole("button", { name: child.title })
      .parentElement?.getAttribute("data-ring"),
  ).toBe("handoff");

  fireEvent.click(overview);
  expect(overview.getAttribute("aria-pressed")).toBe("true");
  expect(
    within(screen.getByRole("region", { name: "Today" }))
      .getByRole("button", { name: goal.title })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(lens.getByRole("button", { name: project.name })).toBeTruthy();
  fireEvent.doubleClick(overview);

  const breadcrumb = within(
    lens.getByRole("navigation", { name: "Treemap breadcrumb" }),
  );
  expect(breadcrumb.getByText(goal.title).getAttribute("aria-current")).toBe(
    "location",
  );
  expect(lens.queryByRole("button", { name: goal.title })).toBeNull();
  expect(breadcrumb.getByRole("button", { name: project.name })).toBeTruthy();
  fireEvent.click(lens.getByRole("button", { name: child.title }));
  expect(
    lens
      .getByRole("button", { name: child.title })
      .getAttribute("aria-pressed"),
  ).toBe("true");

  const ghost = lens.getByRole("button", { name: finished.title });
  expect(ghost.parentElement?.getAttribute("data-ghost")).toBe("true");
  fireEvent.click(
    lens.getByRole("checkbox", { name: "Show completed ghosts" }),
  );
  expect(lens.queryByRole("button", { name: finished.title })).toBeNull();
  fireEvent.click(breadcrumb.getByRole("button", { name: "All projects" }));
  expect(lens.getByRole("button", { name: project.name })).toBeTruthy();
  expect(
    lens
      .getByRole("button", { name: goal.title })
      .getAttribute("aria-description"),
  ).toContain("1 of 3 complete");
  const fill = lens
    .getByRole("button", { name: goal.title })
    .parentElement?.querySelector<HTMLElement>(
      ":scope > .treemap-progress > span",
    );
  expect(Number.parseFloat(fill?.style.width ?? "")).toBeCloseTo(100 / 3);
});

it("places top-level Board cards by project and Radar band with Stream ordering and markers", async () => {
  localStorage.setItem("heed.lens", "board");
  const product = { ...project, id: "product", name: "Product", sort: 1 };
  const hidden = {
    ...project,
    id: "hidden",
    name: "Hidden project",
    hidden: 1,
  } as const;
  const fixed = {
    ...goal,
    id: "fixed",
    title: "Architecture review",
    time_type: "fixed",
    time_at: "2024-04-03T14:00:00Z",
    priority: 1,
    progress: { done: 0, total: 0 },
  } as const;
  const marked = {
    ...goal,
    status: "active",
    scheduled_on: "2024-04-01",
    agent_name: "Build agent",
    last_heartbeat_at: "2024-04-03T11:58:00Z",
    handoff: 1,
    reopen_count: 1,
  } as const;
  const upcoming = {
    ...goal,
    id: "upcoming",
    title: "Publish release notes",
    project_id: product.id,
    scheduled_on: "2024-04-04",
  };
  const ghost = {
    ...goal,
    id: "completed",
    title: "Build export",
    status: "done",
    completed_band: "later",
    completed_at: "2024-04-03T11:00:00Z",
  } as const;
  const backlog = {
    ...goal,
    id: "backlog",
    title: "Review templates",
    scheduled_on: null,
  };
  await openWorkspace(undefined, {
    ...snapshot,
    projects: [project, product, hidden],
    items: [marked, child, tomorrow, fixed, upcoming, ghost, backlog],
  });

  const board = within(
    screen.getByRole("table", { name: "Projects by time band" }),
  );
  expect(
    board.getAllByRole("columnheader").map((header) => header.textContent),
  ).toEqual(["Project", "Today", "This week", "Later", "Backlog"]);
  expect(
    board.getAllByRole("rowheader").map((header) => header.textContent),
  ).toEqual(["Inbox", "Product"]);
  const todayCell = within(
    board
      .getByRole("rowheader", { name: "Inbox" })
      .parentElement!.querySelector('[data-board-band="today"]')!,
  );
  expect(
    todayCell
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("aria-pressed"))
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([fixed.title, goal.title]);
  for (const text of [
    "FIXED",
    "Build agent",
    "0/2 complete",
    "Handoff",
    "Reopened",
    "from Mon",
  ])
    expect(todayCell.getByText(text)).toBeTruthy();
  expect(todayCell.getByRole("img", { name: "Live" })).toBeTruthy();
  for (const [title, projectId, band] of [
    [upcoming.title, product.id, "this-week"],
    [ghost.title, project.id, "later"],
    [backlog.title, project.id, "backlog"],
  ]) {
    expect(
      board.getByRole("button", { name: title }).closest("td")?.dataset,
    ).toMatchObject({ boardProject: projectId, boardBand: band });
  }
  expect(board.queryByRole("button", { name: child.title })).toBeNull();
  expect(board.queryByRole("button", { name: tomorrow.title })).toBeNull();
  fireEvent.click(todayCell.getByRole("button", { name: goal.title }));
  expect(
    todayCell
      .getByRole("button", { name: goal.title })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  const inspector = within(
    screen.getByRole("complementary", { name: "Inspector" }),
  );
  fireEvent.click(inspector.getByRole("button", { name: tomorrow.title }));
  expect(
    (screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value,
  ).toBe(tomorrow.title);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Show completed ghosts" }),
  );
  expect(board.queryByRole("button", { name: ghost.title })).toBeNull();
});

it("commits Board pointer drops through the workspace socket", async () => {
  localStorage.setItem("heed.lens", "board");
  const product = { ...project, id: "product", name: "Product", sort: 1 };
  const first = { ...goal, id: "first", title: "First", sort_key: 10 };
  const second = { ...goal, id: "second", title: "Second", sort_key: 20 };
  const moved = { ...goal, id: "moved", title: "Moved", sort_key: 30 };
  const active = {
    ...goal,
    id: "active",
    title: "Active",
    status: "active",
  } as const;
  await openWorkspace(undefined, {
    ...snapshot,
    projects: [project, product],
    items: [first, second, moved, active],
  });
  const board = screen.getByRole("table", { name: "Projects by time band" });
  const cell = (projectId: string, band: string) =>
    board.querySelector(
      `[data-board-project="${projectId}"][data-board-band="${band}"]`,
    )!;
  const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  const socket = TestSocket.current;

  function drag(title: string, target: Element) {
    const handle = within(board).getByRole("button", { name: `Move ${title}` });
    Object.defineProperty(handle, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 40, 100, 40),
    );
    const pointer = {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 50,
    };
    const sentBefore = socket.send.mock.calls.length;
    const press = createEvent.pointerDown(handle, { ...pointer, clientY: 100 });
    const movement = createEvent.pointerMove(handle, {
      ...pointer,
      clientY: 45,
    });
    Object.defineProperty(movement, "timeStamp", {
      value: press.timeStamp + 500,
    });
    fireEvent(handle, press);
    fireEvent(handle, movement);
    expect(socket.send).toHaveBeenCalledTimes(sentBefore);
    fireEvent.pointerUp(handle, { ...pointer, clientY: 45 });
  }

  try {
    drag(moved.title, board.querySelector('[data-board-card="second"]')!);
    expect(socket.latestRequest()).toMatchObject({
      type: "UPDATE_ITEM",
      input: { item_id: moved.id, sort_key: 15 },
    });
    drag(moved.title, cell(product.id, "today"));
    expect(socket.latestRequest()).toMatchObject({
      type: "UPDATE_ITEM",
      input: { item_id: moved.id, project: product.id },
    });
    drag(moved.title, cell(product.id, "this-week"));
    expect(socket.latestRequest()).toMatchObject({
      type: "UPDATE_ITEM",
      input: { item_id: moved.id, scheduled_on: "2024-04-04" },
    });
    drag(moved.title, cell(project.id, "backlog"));
    expect(socket.latestRequest()).toMatchObject({
      type: "UPDATE_ITEM",
      input: { item_id: moved.id, project: project.id, scheduled_on: null },
    });
    expect(
      cell(project.id, "backlog").contains(
        within(board).getByRole("button", { name: moved.title }),
      ),
    ).toBe(true);
    drag(active.title, cell(product.id, "later"));
    expect(socket.send).toHaveBeenCalledTimes(4);
    expect(screen.getByText(/Active can’t move to Later/)).toBeTruthy();
  } finally {
    if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
    else Reflect.deleteProperty(document, "elementFromPoint");
  }
});

function mockViewport(desktop: boolean) {
  const media = Object.assign(new EventTarget(), { matches: desktop });
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe("(min-width: 768px)");
    return media;
  });
  return (desktop: boolean) => {
    media.matches = desktop;
    act(() => media.dispatchEvent(new Event("change")));
  };
}

it.each(["desktop", "mobile"])(
  "lists each lens once in the %s selector",
  async (layout) => {
    if (layout === "mobile") mockViewport(false);
    await openWorkspace();
    const selector = within(screen.getByRole("combobox", { name: "Lens" }));
    expect(
      selector.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Radar", "Board", "Treemap", "List"]);
  },
);

it.each([
  ["Half", "ArrowUp", "Half"],
  ["Full", "End", "Peek"],
])(
  "reveals an interactive graph from the mobile inspector at %s",
  async (start, key, end) => {
    mockViewport(false);
    await openWorkspace();
    const stream = within(
      screen.getByRole("region", { name: "Horizon Stream" }),
    );
    const handle = stream.getByRole("button", { name: /size: Peek/ });
    fireEvent.keyDown(handle, { key });
    expect(
      stream.getByRole("button", { name: new RegExp(`size: ${start}`) }),
    ).toBe(handle);
    const today = within(screen.getByRole("region", { name: "Today" }));
    fireEvent.click(
      today.getByRole("button", { name: `Expand ${goal.title}` }),
    );
    fireEvent.click(today.getByRole("button", { name: child.title }));
    const drawer = within(screen.getByRole("dialog", { name: "Inspector" }));

    fireEvent.click(
      drawer.getByRole("button", { name: "Open dependency graph" }),
    );

    expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
    expect(
      stream.getByRole("button", { name: new RegExp(`size: ${end}`) }),
    ).toBe(handle);
    const lens = screen.getByRole("region", { name: "Dependencies" });
    expect(lens.hasAttribute("inert")).toBe(false);
    const graph = within(
      within(lens).getByRole("region", {
        name: `Dependency graph for ${goal.title}`,
      }),
    );
    expect(
      graph.getByRole("button", {
        name: /^Review retry policy/,
        pressed: true,
      }),
    ).toBeTruthy();
    fireEvent.click(graph.getByRole("button", { name: /^Run failover drill/ }));
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspector" }),
      ).getByDisplayValue(tomorrow.title),
    ).toBeTruthy();
  },
);

it("reveals Dependencies when chosen from the mobile selector with the Full stream open", async () => {
  mockViewport(false);
  await openWorkspace();
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  fireEvent.click(radar.getByRole("button", { name: goal.title }));
  const handle = screen.getByRole("button", { name: /size: Peek/ });
  fireEvent.keyDown(handle, { key: "End" });

  fireEvent.change(screen.getByRole("combobox", { name: "Lens" }), {
    target: { value: "dependencies" },
  });

  expect(screen.getByRole("button", { name: /size: Peek/ })).toBe(handle);
  const graph = screen.getByRole("region", {
    name: `Dependency graph for ${goal.title}`,
  });
  expect(graph.closest("[inert]")).toBeNull();
});

it("keeps the mobile Radar priority handle usable before and after inspecting", async () => {
  mockViewport(false);
  await openWorkspace();
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  fireEvent.click(radar.getByRole("button", { name: goal.title }));
  expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  const bubble = radar.getByRole("button", { name: tomorrow.title });
  fireEvent.click(bubble);
  expect(bubble.getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();

  const priorityHandle = () =>
    radar.getByRole("slider", { name: `Priority for ${tomorrow.title}` });
  const handle = priorityHandle();
  const node = handle.parentElement!;
  Object.defineProperty(node.parentElement, "getScreenCTM", {
    value: () => null,
  });
  const translate = (element: Element) =>
    element.getAttribute("transform")!.slice(10, -1).split(",").map(Number);
  const [x, y] = translate(node);
  const [dx, dy] = translate(handle);
  const press = {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: x + dx,
    clientY: y + dy,
  };
  const drag = { ...press, clientX: press.clientX + 30 };
  vi.useFakeTimers();
  try {
    fireEvent.pointerDown(handle, press);
    act(() => vi.advanceTimersByTime(450));
    fireEvent.pointerMove(handle, drag);
    fireEvent.pointerUp(handle, drag);
  } finally {
    vi.useRealTimers();
  }
  expect(TestSocket.current.latestRequest()).toMatchObject({
    type: "UPDATE_ITEM",
    input: { item_id: tomorrow.id, priority: 10 },
  });

  fireEvent.click(
    screen.getByRole("button", { name: `Inspect ${tomorrow.title}` }),
  );
  const drawer = within(screen.getByRole("dialog", { name: "Inspector" }));
  expect(drawer.getByDisplayValue(tomorrow.title)).toBeTruthy();
  fireEvent.click(drawer.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  expect(bubble.getAttribute("aria-pressed")).toBe("true");
  expect(priorityHandle()).toBeTruthy();
});

it("lets a second mobile Treemap tap zoom into the selected parent", async () => {
  mockViewport(false);
  localStorage.setItem("heed.lens", "treemap");
  await openWorkspace();
  const treemap = within(screen.getByRole("region", { name: "Treemap" }));
  const tile = treemap.getByRole("button", { name: goal.title });
  const breadcrumb = treemap.getByRole("navigation", {
    name: "Treemap breadcrumb",
  });
  function tap(timeStamp: number) {
    const event = new PointerEvent("click", {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      detail: 1,
    });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    fireEvent(tile, event);
  }

  tap(100);
  expect(tile.getAttribute("aria-pressed")).toBe("true");
  expect(breadcrumb.querySelector("[aria-current]")?.textContent).toBe(
    "All projects",
  );
  expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();

  tap(250);
  expect(breadcrumb.querySelector("[aria-current]")?.textContent).toBe(
    goal.title,
  );
  expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: `Inspect ${goal.title}` }),
  );
  const drawer = screen.getByRole("dialog", { name: "Inspector" });
  expect(within(drawer).getByDisplayValue(goal.title)).toBeTruthy();
  fireEvent(drawer, new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
  expect(
    screen.getByRole("button", { name: `Inspect ${goal.title}` }),
  ).toBeTruthy();
});

it("switches the Board stream between desktop and mobile sheet stops at 768px", async () => {
  const resize = mockViewport(true);
  localStorage.setItem("heed.lens", "board");
  const completed = {
    ...goal,
    id: "completed",
    title: "Close out review",
    status: "done",
    completed_at: "2024-04-03T11:00:00Z",
  } as const;
  await openWorkspace(undefined, {
    ...snapshot,
    items: [...snapshot.items, completed],
  });

  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  expect(stream.getByRole("heading", { name: "Needs me" })).toBeTruthy();
  expect(stream.getByRole("button", { name: child.title })).toBeTruthy();
  expect(stream.getByRole("button", { name: completed.title })).toBeTruthy();
  for (const name of ["Today", "Tomorrow", "This week", "Later", "Backlog"])
    expect(stream.queryByRole("heading", { name })).toBeNull();

  resize(false);
  const dock = within(
    screen.getByRole("navigation", { name: "Workspace shortcuts" }),
  );
  expect(stream.queryByRole("heading", { name: "Today" })).toBeNull();
  expect(stream.getAllByRole("button")).toHaveLength(3);
  const handle = stream.getByRole("button", { name: /size: Peek/ });
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  expect(stream.getByRole("heading", { name: "Today" })).toBeTruthy();
  expect(stream.queryByRole("heading", { name: "Tomorrow" })).toBeNull();
  fireEvent.click(dock.getByRole("button", { name: "List" }));
  expect(stream.getByRole("heading", { name: "Tomorrow" })).toBeTruthy();
  expect(stream.getByRole("heading", { name: "Backlog" })).toBeTruthy();
  fireEvent.click(dock.getByRole("button", { name: "Lens" }));
  expect(stream.queryByRole("heading", { name: "Tomorrow" })).toBeNull();

  fireEvent.click(dock.getByRole("button", { name: "Open quick add" }));
  const quickAdd = screen.getByRole("dialog", { name: "Add a goal" });
  fireEvent.click(within(quickAdd).getByRole("button", { name: "Close" }));

  fireEvent.click(stream.getByRole("button", { name: goal.title }));
  const drawer = screen.getByRole("dialog", { name: "Inspector" });
  expect(
    within(drawer).getByRole("button", { name: "Mark done" }),
  ).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));

  resize(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Lens" }), {
    target: { value: "list" },
  });
  expect(stream.getByRole("heading", { name: "Today" })).toBeTruthy();
  expect(stream.queryByRole("heading", { name: "Needs me" })).toBeNull();
});

it("keeps stream inspector drafts and pending saves across both breakpoint directions", async () => {
  const resize = mockViewport(false);
  await openWorkspace();
  fireEvent.keyDown(screen.getByRole("button", { name: /size: Peek/ }), {
    key: "End",
  });
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  fireEvent.click(stream.getByRole("button", { name: goal.title }));

  let inspector = within(screen.getByRole("dialog", { name: "Inspector" }));
  const title = "Draft payment reliability plan";
  const note = "Confirm the retry budget with the team.";
  fireEvent.change(inspector.getByLabelText("Title"), {
    target: { value: title },
  });
  fireEvent.change(inspector.getByLabelText("Note"), {
    target: { value: note },
  });
  fireEvent.change(inspector.getByLabelText("Priority"), {
    target: { value: "8" },
  });
  fireEvent.change(inspector.getByLabelText("New tag"), {
    target: { value: "payments" },
  });
  fireEvent.click(inspector.getByRole("button", { name: "Add tag" }));
  fireEvent.change(inspector.getByLabelText("New tag"), {
    target: { value: "review" },
  });

  function expectDrafts(expectedNote: string) {
    expect(inspector.getByLabelText<HTMLInputElement>("Title").value).toBe(
      title,
    );
    expect(inspector.getByLabelText<HTMLTextAreaElement>("Note").value).toBe(
      expectedNote,
    );
    expect(inspector.getByLabelText<HTMLSelectElement>("Priority").value).toBe(
      "8",
    );
    expect(
      inspector.getByRole("button", { name: "Remove tag payments" }),
    ).toBeTruthy();
    expect(inspector.getByLabelText<HTMLInputElement>("New tag").value).toBe(
      "review",
    );
  }

  resize(true);
  inspector = within(screen.getByRole("complementary", { name: "Inspector" }));
  expectDrafts(note);

  const revisedNote = `${note} Review the alert thresholds.`;
  fireEvent.change(inspector.getByLabelText("Note"), {
    target: { value: revisedNote },
  });
  resize(false);
  inspector = within(screen.getByRole("dialog", { name: "Inspector" }));
  expectDrafts(revisedNote);

  const socket = TestSocket.current;
  expect(socket.send).not.toHaveBeenCalled();
  fireEvent.click(inspector.getByRole("button", { name: "Save note" }));
  const request = socket.latestRequest();
  expect(request).toMatchObject({
    type: "SET_NOTE",
    input: { item_id: goal.id, note: revisedNote },
  });
  resize(true);
  inspector = within(screen.getByRole("complementary", { name: "Inspector" }));
  expect(
    inspector.getByRole<HTMLButtonElement>("button", { name: "Save note" })
      .disabled,
  ).toBe(true);
  await act(async () =>
    socket.receive({
      type: "ERROR",
      requestId: request.requestId,
      seq: 2,
      error: { code: "invalid_input", message: "Couldn’t save the note." },
    }),
  );
  expect(inspector.getByRole("alert").textContent).toBe(
    "Couldn’t save the note.",
  );
  expect(
    inspector.getByRole<HTMLButtonElement>("button", { name: "Save note" })
      .disabled,
  ).toBe(false);
  expectDrafts(revisedNote);
});

it("keeps a canvas inspector open with its draft after resizing to mobile", async () => {
  const resize = mockViewport(false);
  await openWorkspace();
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  fireEvent.click(radar.getByRole("button", { name: goal.title }));
  expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();

  resize(true);
  const inspector = within(
    screen.getByRole("complementary", { name: "Inspector" }),
  );
  fireEvent.change(inspector.getByLabelText("Title"), {
    target: { value: "Draft payment reliability plan" },
  });

  resize(false);
  const drawer = within(screen.getByRole("dialog", { name: "Inspector" }));
  expect(
    drawer.getByDisplayValue("Draft payment reliability plan"),
  ).toBeTruthy();
  fireEvent.click(drawer.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: `Inspect ${goal.title}` }),
  );
  expect(
    within(screen.getByRole("dialog", { name: "Inspector" })).getByDisplayValue(
      goal.title,
    ),
  ).toBeTruthy();
});
