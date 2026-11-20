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
