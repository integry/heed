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
import {
  COMMAND_TEXT_LIMIT,
  RESET_WORKSPACE_CONFIRMATION,
  WORKSPACE_RESET_CLOSE_CODE,
} from "@heedwork/core";
import type { Event, SocketMessage, SocketRequest } from "@heedwork/core";
import { App } from "./App";
import { onboardingCompletion } from "./Onboarding";
import { mountApp, type MountedApp, type MountAppOptions } from "./index";
import { lensRegistry, type Lens } from "./lenses";
import {
  CENTER,
  cellPoint,
  RADAR_BANDS,
  RADAR_LABELS,
  RADAR_RADIUS,
  radarViewport,
  type Cell,
} from "./radar-geometry";
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

  close(code = 1000) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}

const fetchSession = vi.fn();
let mounted: MountedApp | undefined;

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
  act(() => mounted?.unmount());
  mounted = undefined;
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
    mountHost();
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

function mountHost(options?: MountAppOptions) {
  const root = document.createElement("div");
  document.body.append(root);
  act(() => {
    const app = mountApp(root, options);
    mounted = {
      ...app,
      unmount() {
        app.unmount();
        root.remove();
      },
    };
  });
  return mounted!;
}

it("mounts a host sign-in with the full return path on a session 401", async () => {
  fetchSession.mockImplementation(
    async () => new Response(null, { status: 401 }),
  );
  window.history.replaceState(null, "", "/workspace?item=goal#stream");
  mountHost({ signIn: ({ returnTo }) => <p>Continue to {returnTo}</p> });
  expect(
    await screen.findByText("Continue to /workspace?item=goal#stream"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("link", { name: "Sign in with Google" }),
  ).toBeNull();
});

it("mounts host settings and header slots and drops workspace state on switch", async () => {
  const previousSocket = TestSocket.current;
  let activeWorkspaceId = "launch";
  let role = "editor";
  fetchSession.mockImplementation(async (path: string) =>
    path === "/api/me"
      ? Response.json({
          workspaceId: activeWorkspaceId,
          role,
          user: {
            id: "user-1",
            name: "Workspace user",
            email: "user@example.test",
          },
          managed: true,
        })
      : Response.json({ plan: "Team" }),
  );
  const signOut = vi.fn(async () => {});
  const app = mountHost({
    signIn: () => <h1>Host sign-in</h1>,
    onSignOut: signOut,
    headerStart: ({ workspaceId, onWorkspaceChange }) => (
      <button
        onClick={() => {
          activeWorkspaceId = "research";
          role = "viewer";
          onWorkspaceChange();
        }}
      >
        {workspaceId}
      </button>
    ),
    headerEnd: ({ user }) => <span>{user.name}</span>,
    hideScreens: ["projects", "tokens", "notifications"],
    extraSettingsScreens: [
      {
        id: "plan",
        label: "Workspace plan",
        component: ({ user, workspaceId, role, api }) => {
          const { data } = api.useResource<{ plan: string }>("/api/plan");
          return (
            <p>
              {user.id} / {workspaceId} / {role} / {data?.plan}
            </p>
          );
        },
      },
    ],
  });
  const header = await screen.findByRole("banner");
  expect(within(header).getByText("Workspace user")).toBeTruthy();
  await waitFor(() => expect(TestSocket.current).not.toBe(previousSocket));
  const first = TestSocket.current;
  first.receive(snapshot);
  const stream = screen.getByRole("region", { name: "Horizon Stream" });
  expect(within(stream).getByRole("button", { name: goal.title })).toBeTruthy();

  fireEvent.click(within(header).getByRole("button", { name: "Settings" }));
  const settings = screen.getByRole("dialog", { name: "Settings" });
  expect(
    within(settings).getByRole("region", { name: "Workspace plan" }),
  ).toBeTruthy();
  expect(
    await within(settings).findByText("user-1 / launch / editor / Team"),
  ).toBeTruthy();
  for (const name of [
    "Projects",
    "API tokens",
    "Notifications",
    "Model keys",
    "Data",
  ])
    expect(within(settings).queryByRole("region", { name })).toBeNull();
  expect(screen.queryByText(/Configure Workers AI/)).toBeNull();

  fireEvent.click(within(settings).getByRole("button", { name: "Close" }));
  fireEvent.click(within(header).getByRole("button", { name: "launch" }));
  await screen.findByRole("button", { name: "research" });
  expect(TestSocket.current).not.toBe(first);
  expect(first.readyState).toBe(3);
  TestSocket.current.receive({ ...snapshot, items: [] });
  expect(screen.queryByRole("button", { name: goal.title })).toBeNull();

  const second = TestSocket.current;
  act(() => app.onWorkspaceChange());
  await waitFor(() => expect(TestSocket.current).not.toBe(second));
  expect(second.readyState).toBe(3);

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(
    await screen.findByText("user-1 / research / viewer / Team"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    await screen.findByRole("heading", { name: "Host sign-in" }),
  ).toBeTruthy();
  expect(signOut).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "recovers the built-in sign-in methods after a token request returns 401 (development: %s)",
  async (devLoginEnabled) => {
    fetchSession.mockImplementation(async (path: string) => {
      if (path === "/api/connected-apps") return Response.json([]);
      if (path === "/api/tokens") return new Response(null, { status: 401 });
      return Response.json({ devLoginEnabled }, { status: 401 });
    });
    fetchSession.mockResolvedValueOnce(
      Response.json({ email: "user@example.test", workspaceId: "default" }),
    );
    mountHost();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const socket = TestSocket.current;
    expect(
      (
        await screen.findByRole("link", { name: "Sign in with Google" })
      ).getAttribute("href"),
    ).toBe("/auth/login");
    expect(
      screen
        .queryByRole("link", { name: "Development sign-in" })
        ?.getAttribute("href"),
    ).toBe(devLoginEnabled ? "/auth/dev-login" : undefined);
    expect(fetchSession.mock.calls.map(([path]) => path)).toEqual([
      "/api/me",
      "/api/connected-apps",
      "/api/tokens",
      "/api/me",
    ]);
    expect(socket.readyState).toBe(3);
  },
);

it("shows the host sign-in on a 401 from a host screen API call", async () => {
  fetchSession.mockImplementation(
    async () => new Response(null, { status: 401 }),
  );
  fetchSession.mockResolvedValueOnce(
    Response.json({ email: "user@example.test", workspaceId: "default" }),
  );
  mountHost({
    signIn: () => <h1>Host sign-in</h1>,
    hideScreens: ["tokens"],
    extraSettingsScreens: [
      {
        id: "members",
        label: "Members",
        component: ({ api }) => (
          <button
            onClick={() =>
              void api.postJson("/api/members", {}).catch(() => {})
            }
          >
            Add member
          </button>
        ),
      },
    ],
  });
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Add member" }));
  expect(
    await screen.findByRole("heading", { name: "Host sign-in" }),
  ).toBeTruthy();
  expect(fetchSession.mock.calls.map(([path]) => path)).toEqual([
    "/api/me",
    "/api/members",
    "/api/me",
  ]);
  expect(TestSocket.current.readyState).toBe(3);
});

it("ignores an expiry lookup that finishes after a workspace switch", async () => {
  let finishConfig!: () => void;
  const config = new Promise((resolve) => {
    finishConfig = () => resolve({ devLoginEnabled: true });
  });
  const expired = new Response(null, { status: 401 });
  const readConfig = vi.spyOn(expired, "json").mockReturnValue(config);
  fetchSession
    .mockResolvedValueOnce(
      Response.json({ email: "user@example.test", workspaceId: "launch" }),
    )
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(expired)
    .mockResolvedValueOnce(
      Response.json({ email: "user@example.test", workspaceId: "research" }),
    );

  const app = mountHost({ headerStart: ({ workspaceId }) => workspaceId });
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  await waitFor(() => expect(readConfig).toHaveBeenCalledOnce());
  const lookupSignal = fetchSession.mock.calls[3][1].signal as AbortSignal;

  act(() => app.onWorkspaceChange());
  await screen.findByText("research");
  expect(lookupSignal.aborted).toBe(true);
  const socket = TestSocket.current;
  await act(async () => finishConfig());
  expect(screen.getByText("research")).toBeTruthy();
  expect(
    screen.queryByRole("link", { name: "Development sign-in" }),
  ).toBeNull();
  expect(socket.readyState).toBe(TestSocket.OPEN);
});

it.each([true, false])(
  "applies key management to the command hint when managed is %s",
  async (managed) => {
    fetchSession.mockImplementation(async () =>
      Response.json({
        email: "user@example.test",
        workspaceId: "default",
        managed,
      }),
    );
    mountHost({ hideScreens: ["model-keys", "tokens"] });
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(screen.queryAllByText(/Configure Workers AI/)).toHaveLength(
      managed ? 0 : 1,
    );
    expect(
      within(screen.getByRole("dialog")).queryByRole("heading", {
        name: "Model keys",
      }),
    ).toBeNull();
  },
);

it.each([
  {
    open: "+ Goal",
    region: "Add a goal",
    field: "Title",
    submit: "Add goal",
    type: "ADD_ITEM",
  },
  {
    open: "Settings",
    region: "Projects",
    field: "New project name",
    submit: "Create project",
    type: "CREATE_PROJECT",
  },
  {
    open: "Settings",
    region: "API tokens",
    field: "Label",
    submit: "Create token",
    type: "CREATE_TOKEN",
  },
])(
  "shows the limit refusal inline for $submit",
  async ({ open, region, field, submit, type }) => {
    await openWorkspace();
    fireEvent.click(screen.getByRole("button", { name: open }));
    const form = within(
      screen.getByRole(open === "Settings" ? "region" : "dialog", {
        name: region,
      }),
    );
    fireEvent.change(await form.findByLabelText(field), {
      target: { value: "Launch" },
    });
    fireEvent.click(form.getByRole("button", { name: submit }));
    const socket = TestSocket.current;
    expect(socket.latestRequest().type).toBe(type);
    await act(async () =>
      socket.receive({
        seq: 2,
        type: "ERROR",
        requestId: socket.latestRequest().requestId,
        error: {
          code: "limit_exceeded",
          message: "Creation refused",
          reason: "This workspace has reached its plan limit.",
        },
      }),
    );
    const alert = form.getByRole("alert");
    expect(alert.textContent).toBe(
      "This workspace has reached its plan limit.",
    );
    expect(screen.getAllByRole("alert")).toEqual([alert]);
    expect(form.getByDisplayValue("Launch")).toBeTruthy();
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

async function openCommandBar(...results: Response[]) {
  const submit = vi.fn<(_text: string) => Response>();
  for (const result of results) submit.mockReturnValueOnce(result);
  fetchSession.mockImplementation(
    async (path: string, options?: RequestInit) => {
      if (path === "/api/me") {
        return Response.json({
          workspaceId: "default",
          email: "person@example.test",
          capabilities: { command: true, transcription: false },
        });
      }
      if (path === "/api/command") {
        return submit(JSON.parse(String(options?.body)).text);
      }
      return Response.json([]);
    },
  );
  const previousSocket = TestSocket.current;
  render(<App />);
  await waitFor(() => expect(TestSocket.current).not.toBe(previousSocket));
  TestSocket.current.receive(snapshot);
  const open = screen.queryByRole("button", { name: "Open command bar" });
  if (open) fireEvent.click(open);
  const draft = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Workspace command",
  });
  const send = (text?: string) => {
    if (text !== undefined)
      fireEvent.change(draft, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  };
  return { draft, send, submit };
}

it("keeps each clarification reply once, including when retrying a failed submission", async () => {
  const firstQuestion =
    "Which review do you mean: Billing or Invoices? Reply with the project name.";
  const secondQuestion = "Which goal is it under?";
  const firstReply = `\nClarifying question: ${firstQuestion}\nUser's answer: Billing`;
  const secondReply = `\nClarifying question: ${secondQuestion}\nUser's answer: Invoices`;
  const original = "Move the review to Today and attach this note: ".padEnd(
    COMMAND_TEXT_LIMIT -
      "Original request: ".length -
      firstReply.length -
      secondReply.length,
    "x",
  );
  const firstContinuation = `Original request: ${original}${firstReply}`;
  const secondContinuation = firstContinuation + secondReply;
  const { draft, send, submit } = await openCommandBar(
    Response.json({
      summary: firstQuestion,
      needsClarification: true,
      changes: [],
    }),
    Response.json({
      summary: secondQuestion,
      needsClarification: true,
      changes: [],
    }),
    Response.json(
      { error: { message: "Try again shortly." } },
      { status: 502 },
    ),
    Response.json({
      summary: "Moved the review to Today.",
      needsClarification: false,
      changes: [{ type: "item" }],
    }),
  );

  send(original);
  await screen.findByText(firstQuestion);
  expect(draft.placeholder).toBe("Answer the question…");
  expect(screen.getByRole("button", { name: "New command" })).toBeTruthy();
  send("Billing");
  await screen.findByText(secondQuestion);
  send("Invoices");
  await screen.findByText("Try again shortly.");
  expect(draft.value).toBe("Invoices");
  send();
  await screen.findByText("Moved the review to Today.");
  expect(submit.mock.calls).toEqual([
    [original],
    [firstContinuation],
    [secondContinuation],
    [secondContinuation],
  ]);
});

it("starts a fresh command after an ordinary result ending in a question mark", async () => {
  const summary = 'No item has the title "Ready?" — could it be archived?';
  const { draft, send, submit } = await openCommandBar(
    Response.json({ summary, needsClarification: false, changes: [] }),
    Response.json({
      summary: "Moved the review to Today.",
      needsClarification: false,
      changes: [{ type: "item" }],
    }),
  );

  send("Find my Ready? item");
  await screen.findByText(summary);
  expect(draft.placeholder).toBe("Tell Heed what to change…");
  send("Move the billing review to Today");
  await screen.findByText("Moved the review to Today.");
  expect(submit.mock.lastCall).toEqual(["Move the billing review to Today"]);
});

it("keeps an oversized spoken clarification local and lets the user restate the request", async () => {
  mockViewport(false);
  vi.stubGlobal(
    "SpeechRecognition",
    class extends EventTarget {
      start() {
        this.dispatchEvent(
          Object.assign(new Event("result"), {
            results: [[{ transcript: "Billing" }]],
          }),
        );
        queueMicrotask(() => this.dispatchEvent(new Event("end")));
      }
    },
  );
  const question = "Which project contains the review?";
  const original = "Move the review to Today and attach this note: ".padEnd(
    COMMAND_TEXT_LIMIT,
    "x",
  );
  const restated = "Move the review in Billing to Today.";
  const { draft, send, submit } = await openCommandBar(
    Response.json({ summary: question, needsClarification: true, changes: [] }),
    Response.json({
      summary: "Moved the review to Today.",
      needsClarification: false,
      changes: [{ type: "item" }],
    }),
  );

  send(original);
  await screen.findByText(question);
  fireEvent.click(screen.getByRole("button", { name: "Hold to speak" }));
  await waitFor(() => expect(draft.value).toBe("Billing"));
  send();
  expect(screen.getByRole("alert").textContent).toContain(
    "restate the complete request",
  );
  expect(submit.mock.calls).toEqual([[original]]);
  expect(draft.value).toBe("Billing");
  expect(screen.getByText(question)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "New command" }));
  expect(screen.queryByRole("alert")).toBeNull();
  send(restated);
  await screen.findByText("Moved the review to Today.");
  expect(submit.mock.calls).toEqual([[original], [restated]]);
});

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
  await screen.findByRole("heading", { name: notificationItem.title });

  const reopened = {
    ...notificationItem,
    title: "Review new payment alerts",
    status: "queued",
    completed_at: null,
  } as const;
  socket.receive({ type: "ITEM_UPSERT", seq: 2, item: reopened });
  expect(screen.getByRole("heading", { name: reopened.title })).toBeTruthy();
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
  await screen.findByRole("heading", { name: notificationItem.title });

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
    await screen.findByRole("heading", { name: notificationItem.title });

    socket.receive({ type: "ITEM_UPSERT", seq: 3, item: goal });
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "GET_SNAPSHOT" }),
    );
    socket.receive({ ...snapshot, seq: 4 });
    expect(screen.queryByRole("complementary", inspectorRegion)).toBeNull();
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    if (exists)
      expect(
        await screen.findByRole("heading", { name: "Updated alerts" }),
      ).toBeTruthy();
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
  fireEvent.click(screen.getByRole("tab", { name: "Detail" }));
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

function mockRadarSize(width: number, height: number) {
  let resize: (width: number, height: number) => void;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (!target.classList.contains("radar-chart")) return;
        resize = (width, height) =>
          this.callback(
            [
              {
                target,
                contentRect: new DOMRect(0, 0, width, height),
              } as ResizeObserverEntry,
            ],
            this,
          );
        resize(width, height);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  return (width: number, height: number) => act(() => resize(width, height));
}

it.each([
  [360, 360, 560],
  [390, 390, 560],
  [768, 410, 655],
  [1440, 800, 655],
])(
  "fits the radar and keeps labels at 11px through zoom at %ipx",
  async (width, chartWidth, chartHeight) => {
    mockViewport(width >= 768);
    mockRadarSize(chartWidth, chartHeight);
    const { container } = await openWorkspace(undefined, {
      ...snapshot,
      items: [
        { ...goal, title: "Review payment reconciliation", priority: 10 },
      ],
    });
    const svg = container.querySelector(".radar-svg")!;
    const viewBox = svg.getAttribute("viewBox");
    const viewport = radarViewport(chartWidth, chartHeight, false);
    expect(viewBox).toBe(
      `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`,
    );
    const outer = svg.querySelector('.radar-band[data-band="backlog"]')!;
    expect(Number(outer.getAttribute("r")) * 2 * viewport.scale).toBeCloseTo(
      Math.min(chartWidth, chartHeight) - 50,
    );
    const projectLabel = svg.querySelector(".radar-project-label textPath")!;
    const arc = document.getElementById(
      projectLabel.getAttribute("href")!.slice(1),
    )!;
    expect(
      Number(arc.getAttribute("d")!.split(" A ")[1].split(" ")[0]),
    ).toBeGreaterThan(RADAR_RADIUS);

    function expectLabels(zoom: number) {
      const labels = [
        ...svg.querySelectorAll(
          ".radar-band-label, .radar-project-label, .radar-bubble-title",
        ),
      ];
      expect(labels).toHaveLength(
        5 + svg.querySelectorAll(".radar-bubble-title").length,
      );
      expect(
        labels.some((label) => label.classList.contains("radar-bubble-title")),
      ).toBe(true);
      for (const label of labels) {
        const font = Number(
          label.closest("[font-size]")!.getAttribute("font-size"),
        );
        expect(font * viewport.scale * zoom).toBeCloseTo(11);
      }
      for (const label of svg.querySelectorAll(".radar-bubble-title")) {
        expect(label.querySelectorAll("tspan").length).toBeLessThanOrEqual(2);
      }
    }

    expectLabels(1);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expectLabels(1.35);
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(svg.getAttribute("viewBox")).toBe(viewBox);
    expect(outer.parentElement?.parentElement?.getAttribute("transform")).toBe(
      "translate(0,0) scale(1)",
    );
    expectLabels(1);
  },
);

function radarBubbleGeometry(bubble: Element) {
  const [x, y] = bubble
    .parentElement!.getAttribute("transform")!
    .slice("translate(".length, -1)
    .split(",")
    .map(Number);
  const radius = Number(bubble.querySelector(".radar-disc")!.getAttribute("r"));
  return { x, y, radius };
}

it("renders packed bubbles and hides a ring label when its reservation fills their cell", async () => {
  mockViewport(false);
  const resize = mockRadarSize(360, 280);
  const titles = ["Review payment retries", "Test failover alerts"];
  const { container } = await openWorkspace(undefined, {
    ...snapshot,
    projects: Array.from({ length: 16 }, (_, sort) => ({
      ...project,
      id: sort === 0 ? project.id : `project-${sort}`,
      name: `Project ${sort + 1}`,
      sort,
    })),
    items: titles.map((title, index) => ({
      ...goal,
      id: `item-${index}`,
      title,
      progress: { done: 0, total: 0 },
      priority: 10,
      scheduled_on: tomorrow.scheduled_on,
      layout_pos: '{"radar":{"angle":0.5,"radius":0.5}}',
    })),
  });
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  const labels = () =>
    [...container.querySelectorAll(".radar-band-label")].map(
      (label) => label.textContent,
    );
  expect(labels()).toEqual(["Today · You", "Later", "Backlog"]);
  const [a, b] = titles.map((name) => {
    const geometry = radarBubbleGeometry(radar.getByRole("button", { name }));
    expect(geometry.radius).toBeGreaterThan(0);
    return geometry;
  });
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
    a.radius + b.radius,
  );

  resize(800, 655);
  expect(labels()).toEqual(["Today · You", "This week", "Later", "Backlog"]);
});

it.each(RADAR_BANDS)(
  "opens and closes the %s split with mouse and keyboard",
  async (band) => {
    const { container } = await openWorkspace();
    const radar = within(screen.getByRole("region", { name: "Radar" }));
    const label = radar.getByRole("button", { name: RADAR_LABELS[band] });
    const expanded = () => label.getAttribute("aria-expanded");
    expect(expanded()).toBe("false");
    fireEvent.click(label);
    expect(expanded()).toBe("true");
    expect(
      radar
        .getByText(new RegExp(`^${RADAR_LABELS[band]} split`))
        .getAttribute("aria-live"),
    ).toBe("polite");
    expect(container.querySelector(".radar-subring-label")).toBeTruthy();
    fireEvent.click(label);
    expect(expanded()).toBe("false");

    label.focus();
    fireEvent.keyDown(label, { key: "Enter" });
    expect(expanded()).toBe("true");
    fireEvent.keyDown(label, { key: " " });
    expect(expanded()).toBe("false");
    fireEvent.keyDown(label, { key: "Enter" });
    const nextBand = band === "today" ? "later" : "today";
    const next = radar.getByRole("button", { name: RADAR_LABELS[nextBand] });
    fireEvent.click(next);
    expect(expanded()).toBe("false");
    expect(next.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(radar.getByRole("button", { name: "Reset zoom" }));
    expect(next.getAttribute("aria-expanded")).toBe("false");
    expect(radar.getByText("Whole radar.")).toBeTruthy();
  },
);

it("keeps bubble angles through a split and marks only today's local hard times", async () => {
  const tasks = [
    { ...goal, time_type: "fixed", time_at: "2024-04-03T07:00:00Z" },
    {
      ...tomorrow,
      time_type: "deadline",
      time_at: "2024-04-04T06:30:00Z",
      scheduled_on: null,
      parent_id: null,
    },
    {
      ...goal,
      id: "overdue",
      time_type: "deadline",
      time_at: "2024-04-03T06:59:00Z",
    },
    {
      ...goal,
      id: "future",
      time_type: "fixed",
      time_at: "2024-04-04T07:00:00Z",
    },
  ] as const;
  const { container } = await openWorkspace(undefined, {
    ...snapshot,
    items: [...tasks],
    settings: { ...snapshot.settings, timezone: "America/Los_Angeles" },
  });
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  const coordinates = () =>
    [...container.querySelectorAll(".radar-node")].map((node) =>
      node
        .getAttribute("transform")!
        .slice("translate(".length, -1)
        .split(",")
        .map(Number),
    );
  const before = coordinates();
  fireEvent.click(radar.getByRole("button", { name: "Today" }));
  expect(
    [...container.querySelectorAll(".radar-rim-marker text")]
      .map((node) => node.textContent)
      .sort(),
  ).toEqual(["00:00", "23:30"]);
  const midnight = radar
    .getByRole("img", { name: `00:00, ${goal.title}` })
    .querySelector("line")!;
  expect(Number(midnight.getAttribute("x1"))).toBeCloseTo(CENTER.x);
  expect(Number(midnight.getAttribute("y1"))).toBeLessThan(CENTER.y);
  const after = coordinates();
  for (const [[x, y], [nextX, nextY]] of before.map((point, index) => [
    point,
    after[index],
  ])) {
    expect(Math.atan2(nextY - CENTER.y, nextX - CENTER.x)).toBeCloseTo(
      Math.atan2(y - CENTER.y, x - CENTER.x),
    );
  }
  fireEvent.keyDown(radar.getByRole("button", { name: "Today" }), {
    key: "Escape",
  });
  expect(coordinates()).toEqual(before);
});

it("keeps two saved center positions separated in the Needs me split", async () => {
  mockRadarSize(800, 655);
  const titles = ["Review retry policy", "Approve failover plan"];
  const { container } = await openWorkspace(undefined, {
    ...snapshot,
    items: titles.map((title, index) => ({
      ...goal,
      id: `handoff-${index}`,
      title,
      progress: { done: 0, total: 0 },
      handoff: 1,
      layout_pos: '{"radar":{"angle":0.25,"radius":0}}',
    })),
  });
  const radar = within(screen.getByRole("region", { name: "Radar" }));

  fireEvent.click(radar.getByRole("button", { name: "Today" }));
  const innerRingEdge = Number(
    container.querySelector(".radar-subring")!.getAttribute("r"),
  );
  const [a, b] = titles.map((name) => {
    const bubble = radarBubbleGeometry(radar.getByRole("button", { name }));
    expect(bubble.radius).toBeGreaterThan(0);
    expect(Math.hypot(bubble.x - CENTER.x, bubble.y - CENTER.y)).toBeLessThan(
      innerRingEdge,
    );
    return bubble;
  });
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
    a.radius + b.radius,
  );
});

it("uses manual order and priority in Next when saved radii run in reverse", async () => {
  mockRadarSize(800, 655);
  const tasks = [
    {
      id: "review-checklist",
      title: "Review rollout checklist",
      sort_key: 1,
      priority: 4,
      radius: 0.8,
    },
    {
      id: "verify-failover",
      title: "Plan failover drill",
      sort_key: 2,
      priority: 8,
      radius: 0.5,
    },
    {
      id: "update-runbook",
      title: "Update runbook",
      sort_key: 2,
      priority: 5,
      radius: 0.2,
    },
  ];
  const { container } = await openWorkspace(undefined, {
    ...snapshot,
    items: tasks.map(({ radius, ...task }) => ({
      ...goal,
      ...task,
      progress: { done: 0, total: 0 },
      layout_pos: JSON.stringify({ radar: { angle: 0.35, radius } }),
    })),
  });
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  const distances = () =>
    tasks.map(({ title }) => {
      const { x, y } = radarBubbleGeometry(
        radar.getByRole("button", { name: title }),
      );
      return Math.hypot(x - CENTER.x, y - CENTER.y);
    });
  const [beforeFirst, beforeSecond, beforeThird] = distances();
  expect(beforeFirst).toBeGreaterThan(beforeSecond);
  expect(beforeSecond).toBeGreaterThan(beforeThird);

  fireEvent.click(radar.getByRole("button", { name: "Today" }));
  const [, inner, outer] = [
    ...container.querySelectorAll(".radar-subring"),
  ].map((ring) => Number(ring.getAttribute("r")));
  const [first, second, third] = distances();
  expect(first).toBeGreaterThan(inner);
  expect(first).toBeLessThan(second);
  expect(second).toBeLessThan(third);
  expect(third).toBeLessThan(outer);
});

it("keeps manually ordered Next bubbles separated at their saved angles", async () => {
  mockRadarSize(1350, 1350);
  const positions = [
    { angle: 0.5, radius: 0.31 },
    { angle: 0.5, radius: 0.75 },
    { angle: 0, radius: 0.75 },
  ];
  const titles = [
    "Review rollout checklist",
    "Plan failover drill",
    "Update runbook",
  ];
  await openWorkspace(undefined, {
    ...snapshot,
    items: titles.map((title, index) => ({
      ...goal,
      id: `next-${index}`,
      title,
      sort_key: index + 1,
      priority: 4,
      progress: { done: 0, total: 0 },
      layout_pos: JSON.stringify({ radar: positions[index] }),
    })),
  });
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  const geometry = () =>
    titles.map((name) =>
      radarBubbleGeometry(radar.getByRole("button", { name })),
    );
  const [beforeFirst, beforeSecond] = geometry();
  expect(beforeFirst.radius).toBe(20);
  expect(beforeSecond.radius).toBe(20);
  expect(beforeFirst.x).toBeCloseTo(beforeSecond.x);
  expect(beforeSecond.y - beforeFirst.y).toBeCloseTo(45.32);

  fireEvent.click(radar.getByRole("button", { name: "Today" }));
  const after = geometry();
  const distances = after.map(({ x, y }) =>
    Math.hypot(x - CENTER.x, y - CENTER.y),
  );
  expect(distances[0]).toBeLessThan(distances[1]);
  expect(distances[1]).toBeLessThan(distances[2]);
  expect(after[0].x).toBeCloseTo(CENTER.x);
  expect(after[1].x).toBeCloseTo(CENTER.x);
  expect(after[2].x).toBeCloseTo(CENTER.x);
  expect(after[0].y).toBeGreaterThan(CENTER.y);
  expect(after[1].y).toBeGreaterThan(CENTER.y);
  expect(after[2].y).toBeLessThan(CENTER.y);
  for (const [index, bubble] of after.entries()) {
    expect(bubble.radius).toBeGreaterThan(0);
    for (const other of after.slice(index + 1)) {
      expect(
        Math.hypot(bubble.x - other.x, bubble.y - other.y),
      ).toBeGreaterThanOrEqual(bubble.radius + other.radius);
    }
  }
});

it("keeps bubbles separated when a split shifts another band inward", async () => {
  mockRadarSize(1350, 1350);
  const titles = ["Audit retries", "Check alerts"];
  await openWorkspace(undefined, {
    ...snapshot,
    items: titles.map((title, index) => ({
      ...goal,
      id: `week-${index}`,
      title,
      scheduled_on: tomorrow.scheduled_on,
      priority: 4,
      progress: { done: 0, total: 0 },
      layout_pos: JSON.stringify({
        radar: { angle: 0.5 + index * 0.0515, radius: 0.5 },
      }),
    })),
  });
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  const geometry = () =>
    titles.map((name) =>
      radarBubbleGeometry(radar.getByRole("button", { name })),
    );
  const [before] = geometry();
  expect(before.radius).toBe(20);
  expect(Math.hypot(before.x - CENTER.x, before.y - CENTER.y)).toBeCloseTo(140);

  fireEvent.click(radar.getByRole("button", { name: "Backlog" }));
  const [a, b] = geometry();
  expect(Math.hypot(a.x - CENTER.x, a.y - CENTER.y)).toBeCloseTo(85);
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
    a.radius + b.radius,
  );
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
  at?: { x: number; y: number },
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
  const target =
    at ??
    (overview
      ? cellPoint({ band, sector: 0, sectors: 1 }, { angle: 0.5, radius: 0.5 })
      : { x: 175 + RADAR_BANDS.indexOf(band) * 150, y: 716 });
  const pointer = { pointerId: 1, isPrimary: true, button: 0 };
  const destination = { ...pointer, clientX: target.x, clientY: target.y };
  fireEvent.pointerDown(bubble, { ...pointer, clientX, clientY });
  fireEvent.pointerMove(bubble, destination);
  return () => fireEvent.pointerUp(bubble, destination);
}

it.each([
  ["2024-03-10T07:30:00Z", "2024-03-10", "Sun", null],
  ["2024-03-10T08:30:00Z", "2024-03-11", "Mon", null],
  ["2024-03-12T08:30:00Z", "2024-03-16", "Sat", "2024-03-14"],
])(
  "reschedules a radar day drop from %s to workspace date %s",
  async (instant, day, weekday, scheduled_on) => {
    vi.mocked(Date.now).mockReturnValue(Date.parse(instant));
    const task = { ...goal, scheduled_on };
    const { container } = await openWorkspace(undefined, {
      ...snapshot,
      items: [task],
      settings: { ...snapshot.settings, timezone: "America/Los_Angeles" },
    });
    const radar = within(screen.getByRole("region", { name: "Radar" }));
    fireEvent.click(radar.getByRole("button", { name: "This week" }));
    const subring = container.querySelector(`[data-day="${day}"]`)!;
    expect(subring.textContent).toBe(weekday);
    const radius = CENTER.y - Number(subring.getAttribute("y"));
    const release = startRadarRingDrop(
      radar.getByRole("button", { name: task.title }),
      true,
      "this-week",
      { x: CENTER.x, y: CENTER.y + radius },
    );
    release();
    expect(TestSocket.current.latestRequest()).toMatchObject({
      type: "UPDATE_ITEM",
      input: {
        item_id: task.id,
        scheduled_on: day,
        layout_pos: {
          radar: { angle: expect.closeTo(0.5), radius: expect.closeTo(0.5) },
        },
      },
    });
  },
);

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
    if (source === "List") {
      fireEvent.click(screen.getByRole("tab", { name: "List" }));
      const list = within(screen.getByRole("region", { name: "List" }));
      fireEvent.click(
        list.getByRole("button", { name: new RegExp(task.title) }),
      );
      fireEvent.click(screen.getByRole("tab", { name: "Radar" }));
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
  expect(screen.queryByRole("tab", { name: "Dependencies" })).toBeNull();
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
        fireEvent.click(screen.getByRole("tab", { name: "List" }));
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
  fireEvent.click(screen.getByRole("tab", { name: "Radar" }));
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

it("opens a read-only inspector and exposes additional field editors in one disclosure", async () => {
  const item = {
    ...goal,
    note: "Confirm the rollback plan.",
    ref_url: "https://example.test/plan",
    locked_fields: '["priority","acceptance"]',
  };
  await openWorkspace(undefined, { ...snapshot, items: [item, child] });
  const inspector = inspect(item.title);
  const card = screen.getByRole("complementary", inspectorRegion);
  expect(inspector.getByRole("heading", { name: item.title })).toBeTruthy();
  expect(inspector.getByText(item.note)).toBeTruthy();
  expect(
    inspector.getByRole("link", { name: /Open link/ }).getAttribute("href"),
  ).toBe(item.ref_url);
  expect(inspector.getByRole("img", { name: "Priority locked" })).toBeTruthy();
  expect(
    inspector.getByRole("img", { name: "Acceptance criteria locked" }),
  ).toBeTruthy();
  for (const name of ["Mark done", "Flag handoff", "Hide", "Delete"])
    expect(inspector.getByRole("button", { name })).toBeTruthy();
  expect(card.querySelector("input, select, textarea")).toBeNull();
  expect(await inspector.findByText("No activity yet.")).toBeTruthy();

  const summary = inspector.getByText("Edit details");
  expect(summary.closest("details")?.open).toBe(false);
  fireEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  for (const name of [
    "Project",
    "Priority",
    "Schedule",
    "Time type",
    "New tag",
    "Blocked by",
    "Link",
  ])
    expect(inspector.getByLabelText(name)).toBeTruthy();
  fireEvent.click(summary);
  expect(card.querySelector("input, select, textarea")).toBeNull();
});

it("saves and cancels title and criterion edits in place, and adds and removes criteria", async () => {
  const item = { ...goal, acceptance: '["Run smoke tests"]' };
  await openWorkspace(undefined, { ...snapshot, items: [item, child] });
  const inspector = inspect(item.title);
  const editor = within(
    inspector.getByRole("region", { name: "Acceptance criteria" }),
  );
  const socket = TestSocket.current;
  let current = item;
  let seq = 1;

  async function confirm(
    patch: Partial<typeof item>,
    input: Record<string, unknown>,
  ) {
    expect(socket.latestRequest()).toMatchObject({
      type: "UPDATE_ITEM",
      input: { item_id: item.id, ...input },
    });
    current = { ...current, ...patch };
    socket.receive({ type: "ITEM_UPSERT", item: current, seq: ++seq });
    await act(async () =>
      socket.receive({
        type: "ACK",
        seq: ++seq,
        requestId: socket.latestRequest().requestId,
      }),
    );
  }

  const newTitle = "Payment rollout";
  fireEvent.click(
    inspector.getByRole("button", { name: `${item.title} — edit title` }),
  );
  fireEvent.change(inspector.getByRole("textbox", { name: "Title" }), {
    target: { value: "Discard this" },
  });
  fireEvent.keyDown(inspector.getByRole("textbox", { name: "Title" }), {
    key: "Escape",
  });
  expect(document.activeElement).toBe(
    inspector.getByRole("button", { name: `${item.title} — edit title` }),
  );
  expect(socket.send).not.toHaveBeenCalled();
  fireEvent.click(
    inspector.getByRole("button", { name: `${item.title} — edit title` }),
  );
  fireEvent.change(inspector.getByRole("textbox", { name: "Title" }), {
    target: { value: newTitle },
  });
  fireEvent.keyDown(inspector.getByRole("textbox", { name: "Title" }), {
    key: "Enter",
  });
  await confirm({ title: newTitle }, { title: newTitle });
  expect(inspector.getByRole("heading", { name: newTitle })).toBeTruthy();

  fireEvent.click(editor.getByRole("button", { name: "Run smoke tests" }));
  const first = editor.getByRole("textbox", { name: "Criterion 1" });
  fireEvent.change(first, { target: { value: "Discard this too" } });
  fireEvent.keyDown(first, { key: "Escape" });
  expect(editor.queryByRole("textbox")).toBeNull();
  expect(socket.send).toHaveBeenCalledTimes(1);
  fireEvent.click(editor.getByRole("button", { name: "Run smoke tests" }));
  const revised = editor.getByRole("textbox", { name: "Criterion 1" });
  fireEvent.change(revised, { target: { value: "Smoke tests pass" } });
  fireEvent.keyDown(revised, { key: "Enter" });
  await confirm(
    { acceptance: '["Smoke tests pass"]' },
    { acceptance: ["Smoke tests pass"] },
  );

  fireEvent.click(editor.getByRole("button", { name: "Add criterion" }));
  const addition = editor.getByRole("textbox", { name: "Criterion 2" });
  fireEvent.change(addition, { target: { value: "Rollback verified" } });
  fireEvent.keyDown(addition, { key: "Enter" });
  await confirm(
    { acceptance: '["Smoke tests pass","Rollback verified"]' },
    { acceptance: ["Smoke tests pass", "Rollback verified"] },
  );
  expect(
    editor.getByRole("button", { name: "Rollback verified" }),
  ).toBeTruthy();

  fireEvent.click(editor.getByRole("button", { name: "Remove criterion 1" }));
  await confirm(
    { acceptance: '["Rollback verified"]' },
    { acceptance: ["Rollback verified"] },
  );
  expect(editor.queryByRole("button", { name: "Smoke tests pass" })).toBeNull();
  expect(editor.queryByRole("button", { name: /^Move criterion/i })).toBeNull();
});

it("shows evidence and the latest shadow verdict in the mobile inspector and changes feedback over the socket", async () => {
  mockViewport(false);
  const evidence = "  Test suite\n    12 passed\n";
  const baseEvent = { item_id: goal.id, at: goal.updated_at, actor: "Runner" };
  const completion: Event = {
    ...baseEvent,
    id: 2,
    kind: "status",
    detail: JSON.stringify({ new: "done", evidence }),
  };
  const verdict: Event = {
    ...baseEvent,
    id: 3,
    kind: "judged",
    detail: JSON.stringify({
      status_event_id: 2,
      model: "judge/example",
      criteria: [
        "Unit tests pass",
        "Load test passes",
        "Review is complete",
        "Docs published",
      ],
      probabilities: [0.7, 0.3, 0.51, null],
      evidence_supplied: true,
    }),
  };
  const older: Event = {
    ...verdict,
    id: 1,
    detail: verdict.detail!.replace("judge/example", "judge/older"),
  };
  const events = [verdict, completion, older];
  const criteria = JSON.parse(verdict.detail!).criteria;
  const judged = { ...goal, acceptance: JSON.stringify(criteria) };
  await openWorkspace(undefined, { ...snapshot, items: [judged, child] }, () =>
    Response.json(events),
  );
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  fireEvent.click(stream.getByRole("button", { name: /Payment reliability/ }));
  const inspector = within(screen.getByRole("dialog", { name: "Inspector" }));
  const result = within(
    await inspector.findByRole("region", { name: "Shadow verdict" }),
  );
  expect(result.getByText("judge/example · Evidence supplied")).toBeTruthy();
  const acceptance = within(
    inspector.getByRole("region", { name: "Acceptance criteria" }),
  );
  for (const [criterion, score] of [
    ["Unit tests pass", "Likely met · 70%"],
    ["Load test passes", "Likely not met · 30%"],
    ["Review is complete", "Unclear · 51%"],
    ["Docs published", "Unclear · No probability"],
  ]) {
    const row = acceptance
      .getByRole("button", { name: criterion })
      .closest("li")!;
    expect(within(row).getByText(score)).toBeTruthy();
  }
  expect(
    screen
      .getByRole("dialog", { name: "Inspector" })
      .querySelector("input, select, textarea"),
  ).toBeNull();
  expect(result.getByText(/Advisory only/)).toBeTruthy();
  expect(inspector.queryByText(/judge\/older/)).toBeNull();
  const disclosure = inspector.getByText("Evidence").closest("details")!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector("pre")?.textContent).toBe(evidence);

  const agree = result.getByRole("button", { name: "Agree" });
  const disagree = result.getByRole("button", { name: "Disagree" });
  expect(agree.getAttribute("aria-pressed")).toBe("false");
  expect(disagree.getAttribute("aria-pressed")).toBe("false");
  const socket = TestSocket.current;
  let seq = 1;
  for (const [button, other, agrees] of [
    [agree, disagree, true],
    [disagree, agree, false],
  ] as const) {
    fireEvent.click(button);
    const input = { item_id: goal.id, judged_event_id: verdict.id, agrees };
    expect(socket.latestRequest()).toMatchObject({
      type: "JUDGE_FEEDBACK",
      input,
    });
    const feedback: Event = {
      ...baseEvent,
      id: seq + 3,
      kind: "judge_feedback",
      detail: JSON.stringify({ judged_event_id: verdict.id, agrees }),
    };
    events.unshift(feedback);
    socket.receive({ type: "EVENT_APPEND", seq: ++seq, event: feedback });
    await act(async () =>
      socket.receive({
        type: "ACK",
        seq: ++seq,
        requestId: socket.latestRequest().requestId,
      }),
    );
    await waitFor(() =>
      expect(button.getAttribute("aria-pressed")).toBe("true"),
    );
    expect(other.getAttribute("aria-pressed")).toBe("false");
  }
  socket.receive({
    type: "ITEM_UPSERT",
    seq: ++seq,
    item: {
      ...judged,
      acceptance: '["Docs published","Unit tests pass"]',
    },
  });
  expect(result.getByText("Judged against earlier criteria")).toBeTruthy();
  expect(result.getByText("Likely met · 70%")).toBeTruthy();
  const currentDocs = acceptance
    .getByRole("button", { name: "Docs published" })
    .closest("li")!;
  expect(within(currentDocs).queryByText(/%|No probability/)).toBeNull();
});

it("marks the stream row only when its latest completion has a verdict", async () => {
  const item = {
    ...goal,
    status: "done" as const,
    completed_at: "2024-04-03T11:00:00Z",
  };
  const base = { item_id: item.id, at: item.completed_at, actor: "Runner" };
  const first: Event = {
    ...base,
    id: 1,
    kind: "status",
    detail: '{"new":"done"}',
  };
  const latest: Event = { ...first, id: 3 };
  const verdict: Event = {
    ...base,
    id: 4,
    kind: "judged",
    detail: JSON.stringify({
      status_event_id: first.id,
      model: "judge/example",
      criteria: ["Smoke tests pass"],
      probabilities: [0.9],
      evidence_supplied: true,
    }),
  };
  const events = [verdict, latest, first];
  const eventRequests = vi.fn(() => Response.json(events));
  await openWorkspace(undefined, { ...snapshot, items: [item] }, eventRequests);
  const stream = within(screen.getByRole("region", { name: "Horizon Stream" }));
  const row = within(stream.getByRole("button", { name: item.title }));
  expect(row.queryByTitle("Shadow verdict available")).toBeNull();

  const currentVerdict = {
    ...verdict,
    id: 5,
    detail: verdict.detail!.replace(
      '"status_event_id":1',
      '"status_event_id":3',
    ),
  };
  events.unshift(currentVerdict);
  TestSocket.current.receive({
    type: "EVENT_APPEND",
    seq: 2,
    event: currentVerdict,
  });
  expect(await row.findByTitle("Shadow verdict available")).toBeTruthy();

  events.unshift({ ...latest, id: 6 });
  TestSocket.current.receive({
    type: "ITEM_UPSERT",
    seq: 3,
    item: {
      ...item,
      completed_at: "2024-04-03T11:30:00Z",
      reopen_count: 1,
    },
  });
  await waitFor(() =>
    expect(eventRequests.mock.calls.length).toBeGreaterThanOrEqual(3),
  );
  expect(row.queryByTitle("Shadow verdict available")).toBeNull();
});

it("shows optional judging in settings and refreshes counts and agreement as verdicts arrive", async () => {
  let agreement = { verdicts: 0, reviewed: 0, agreed: 0 };
  await openWorkspace(undefined, snapshot, (path) =>
    Response.json(path === "/api/judge/agreement" ? agreement : []),
  );
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const section = within(screen.getByRole("region", { name: "Shadow judge" }));
  expect(
    await section.findByText(/No verdicts yet.*optional.*host/),
  ).toBeTruthy();

  agreement = { verdicts: 3, reviewed: 0, agreed: 0 };
  const socket = TestSocket.current;
  const event = {
    item_id: goal.id,
    id: 2,
    at: goal.updated_at,
    actor: "Runner",
    detail: null,
  };
  socket.receive({
    type: "EVENT_APPEND",
    seq: 2,
    event: { ...event, kind: "judged" },
  });
  await section.findByText("Verdicts");
  expect(
    section.getAllByRole("definition").map((entry) => entry.textContent),
  ).toEqual(["3", "0", "—"]);

  agreement = { verdicts: 3, reviewed: 2, agreed: 1 };
  socket.receive({
    type: "EVENT_APPEND",
    seq: 3,
    event: { ...event, id: 3, kind: "judge_feedback" },
  });
  await section.findByText("50%");
  expect(
    section.getAllByRole("definition").map((entry) => entry.textContent),
  ).toEqual(["3", "2", "50%"]);
});

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

  fireEvent.click(inspector.getByText("Edit details"));
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
  fireEvent.click(inspector.getByText("Edit details"));
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

it("offers export and requires the exact reset phrase before sending a socket mutation", async () => {
  await openWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const data = within(screen.getByRole("region", { name: "Data" }));
  expect(data.getByRole("link", { name: "Export" }).getAttribute("href")).toBe(
    "/api/export",
  );
  fireEvent.click(data.getByRole("button", { name: "Reset workspace" }));
  expect(
    data
      .getByRole("link", { name: "Export before resetting" })
      .hasAttribute("download"),
  ).toBe(true);
  const input = data.getByLabelText(
    `Type ${RESET_WORKSPACE_CONFIRMATION} to confirm`,
  );
  const submit = data.getByRole("button", {
    name: "Permanently reset workspace",
  }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: "reset workspace" } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(input, { target: { value: RESET_WORKSPACE_CONFIRMATION } });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  const socket = TestSocket.current;
  const request = socket.latestRequest();
  expect(request).toMatchObject({
    type: "RESET_WORKSPACE",
    input: { confirmation: RESET_WORKSPACE_CONFIRMATION },
  });
  expect(data.getByRole("button", { name: "Resetting…" })).toBeTruthy();
  await act(async () => {
    socket.receive({ type: "ACK", seq: 2, requestId: request.requestId });
    socket.close(WORKSPACE_RESET_CLOSE_CODE);
  });
  expect(data.getByRole("status").textContent).toContain(
    "Your Inbox is now empty.",
  );
  expect(screen.queryByRole("button", { name: goal.title })).toBeNull();
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
  const client = settings.getByLabelText("MCP client");
  fireEvent.change(client, { target: { value: "cursor" } });
  const cursor = settings.getByLabelText(
    /Cursor MCP config/,
  ) as HTMLTextAreaElement;
  expect(JSON.parse(cursor.value).mcpServers.heed).toEqual({
    url: new URL("/mcp", location.origin).href,
    headers: { Authorization: `Bearer ${token}` },
  });
  fireEvent.change(client, { target: { value: "codex" } });
  const codex = settings.getByLabelText(
    /Codex MCP config/,
  ) as HTMLTextAreaElement;
  expect(codex.value).toContain("[mcp_servers.heed]");
  expect(codex.value).toContain(`Authorization = "Bearer ${token}"`);
  fireEvent.click(settings.getByRole("button", { name: "Copy MCP config" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(codex.value));
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
  fireEvent.click(inspector.getByText("Edit details"));
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
  fireEvent.click(inspector.getByText("Edit details"));
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
  fireEvent.click(screen.getByRole("tab", { name: "Treemap" }));

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
  expect(screen.getByRole("heading", { name: tomorrow.title })).toBeTruthy();
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
  "switches and focuses lens tabs with the keyboard on %s",
  async (layout) => {
    if (layout === "mobile") mockViewport(false);
    await openWorkspace();
    const tabs = within(screen.getByRole("tablist", { name: "Lens" }));
    expect(tabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Radar",
      "Board",
      "Treemap",
      "List",
    ]);
    const radar = tabs.getByRole("tab", { name: "Radar", selected: true });
    const list = tabs.getByRole("tab", { name: "List", selected: false });
    expect(radar.tabIndex).toBe(0);
    expect(list.tabIndex).toBe(-1);
    radar.focus();
    fireEvent.keyDown(radar, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(list);
    expect(list.tabIndex).toBe(0);
    expect(radar.tabIndex).toBe(-1);
    expect(screen.getByRole("tabpanel", { name: "List" })).toBeTruthy();
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(radar);
    expect(tabs.getByRole("tab", { name: "Radar", selected: true })).toBe(
      radar,
    );
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
      within(screen.getByRole("dialog", { name: "Inspector" })).getByRole(
        "heading",
        { name: tomorrow.title },
      ),
    ).toBeTruthy();
  },
);

it("reveals Dependencies when chosen from the mobile lens tabs with the Full stream open", async () => {
  mockViewport(false);
  await openWorkspace();
  const radar = within(screen.getByRole("region", { name: "Radar" }));
  fireEvent.click(radar.getByRole("button", { name: goal.title }));
  const handle = screen.getByRole("button", { name: /size: Peek/ });
  fireEvent.keyDown(handle, { key: "End" });

  fireEvent.click(screen.getByRole("tab", { name: "Dependencies" }));

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
  const drag = { ...press, clientX: press.clientX + 40 };
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
  expect(drawer.getByRole("heading", { name: tomorrow.title })).toBeTruthy();
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
  expect(
    within(drawer).getByRole("heading", { name: goal.title }),
  ).toBeTruthy();
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

  expect(dock.queryByRole("button", { name: "Open command bar" })).toBeNull();
  fireEvent.click(dock.getByRole("button", { name: "+ Goal" }));
  const quickAdd = screen.getByRole("dialog", { name: "Add a goal" });
  fireEvent.click(within(quickAdd).getByRole("button", { name: "Close" }));

  fireEvent.click(stream.getByRole("button", { name: goal.title }));
  const drawer = screen.getByRole("dialog", { name: "Inspector" });
  expect(
    within(drawer).getByRole("button", { name: "Mark done" }),
  ).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));

  resize(true);
  fireEvent.click(screen.getByRole("tab", { name: "List" }));
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
  fireEvent.click(
    inspector.getByRole("button", { name: `${goal.title} — edit title` }),
  );
  fireEvent.click(inspector.getByRole("button", { name: "Add note" }));
  fireEvent.click(inspector.getByText("Edit details"));
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
  fireEvent.click(
    inspector.getByRole("button", { name: `${goal.title} — edit title` }),
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
    within(screen.getByRole("dialog", { name: "Inspector" })).getByRole(
      "heading",
      { name: goal.title },
    ),
  ).toBeTruthy();
});

const emptyOnboarding = {
  hasItems: false,
  hasGoalOrProject: false,
  hasDemoData: false,
  hasToken: false,
};

it("computes the four steps from real work, tokens, saved guidance and this device", () => {
  expect(
    onboardingCompletion(
      { ...emptyOnboarding, hasItems: true, hasDemoData: true },
      "  ",
      false,
    ),
  ).toEqual({
    work: false,
    agent: false,
    guidance: false,
    notifications: false,
  });
  expect(
    onboardingCompletion(
      { ...emptyOnboarding, hasGoalOrProject: true, hasToken: true },
      "Focus on today.",
      true,
    ),
  ).toEqual({ work: true, agent: true, guidance: true, notifications: true });
});

it("mounts the first-run guide for hosts and reopens the dismissed guide from Settings", async () => {
  const previous = TestSocket.current;
  fetchSession.mockImplementation(async (path: string) =>
    Response.json(
      path === "/api/me"
        ? { workspaceId: "host", email: "demo@example.test" }
        : [],
    ),
  );
  mountHost();
  await waitFor(() => expect(TestSocket.current).not.toBe(previous));
  const socket = TestSocket.current;
  socket.receive({ ...snapshot, items: [], onboarding: emptyOnboarding });
  const guide = within(
    screen.getByRole("region", { name: "Set up your workspace" }),
  );
  expect(guide.getByRole("progressbar").getAttribute("value")).toBe("0");

  fireEvent.click(guide.getByRole("button", { name: "Open guidance" }));
  const guidance = within(screen.getByRole("dialog", { name: "Guidance" }));
  const examples = guidance.getAllByRole("button", { name: /Use example:/ });
  expect(examples).toHaveLength(3);
  fireEvent.click(examples[0]);
  fireEvent.click(guidance.getByRole("button", { name: "Save guidance" }));
  const request = socket.latestRequest();
  if (request.type !== "SET_GUIDANCE")
    throw new Error("Expected a guidance save");
  expect(request.input.text).toContain("customer-facing incidents");
  const settings = { ...snapshot.settings, guidance: request.input.text };
  socket.receive({ type: "SETTINGS_UPDATE", seq: 2, settings });
  await act(async () =>
    socket.receive({ type: "ACK", seq: 3, requestId: request.requestId }),
  );
  fireEvent.click(guidance.getByRole("button", { name: "Close" }));

  const opened = within(
    screen.getByRole("dialog", { name: "Set up your workspace" }),
  );
  expect(opened.getByRole("progressbar").getAttribute("value")).toBe("1");
  socket.receive({
    type: "ONBOARDING_UPDATE",
    seq: 4,
    onboarding: { ...emptyOnboarding, hasToken: true },
  });
  expect(opened.getByRole("progressbar").getAttribute("value")).toBe("2");
  fireEvent.click(opened.getByRole("button", { name: "Dismiss guide" }));
  const dismiss = socket.latestRequest();
  expect(dismiss.type).toBe("DISMISS_ONBOARDING");
  socket.receive({
    type: "SETTINGS_UPDATE",
    seq: 5,
    settings: { ...settings, onboarding_dismissed: true },
  });
  await act(async () =>
    socket.receive({ type: "ACK", seq: 6, requestId: dismiss.requestId }),
  );
  expect(
    screen.queryByRole("heading", { name: "Set up your workspace" }),
  ).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Settings" })).getByRole(
      "button",
      { name: "Open setup guide" },
    ),
  );
  expect(
    screen.getByRole("dialog", { name: "Set up your workspace" }),
  ).toBeTruthy();
});

it.each([
  ["radar", "Radar"],
  ["board", "Board"],
  ["treemap", "Treemap"],
  ["list", "List"],
  ["dependencies", "Dependencies"],
])(
  "links the empty %s lens and Horizon Stream back to the guide",
  async (id, label) => {
    localStorage.setItem("heed.lens", id);
    await openWorkspace(undefined, {
      ...snapshot,
      items: [],
      settings: { ...snapshot.settings, onboarding_dismissed: true },
      onboarding: emptyOnboarding,
    });
    const lens = within(screen.getByRole("region", { name: label }));
    const stream = within(
      screen.getByRole("region", { name: "Horizon Stream" }),
    );
    expect(lens.getByRole("button", { name: "Open setup guide" })).toBeTruthy();
    fireEvent.click(stream.getByRole("button", { name: "Open setup guide" }));
    expect(
      screen.getByRole("dialog", { name: "Set up your workspace" }),
    ).toBeTruthy();
  },
);

it("replaces the canvas with labeled demo rows and exposes demo removal in Settings", async () => {
  await openWorkspace(undefined, {
    ...snapshot,
    items: [],
    onboarding: emptyOnboarding,
  });
  fireEvent.click(screen.getByRole("button", { name: "Load demo data" }));
  const socket = TestSocket.current;
  const load = socket.latestRequest();
  expect(load.type).toBe("LOAD_DEMO_DATA");
  socket.receive({
    type: "CANVAS_REPLACE",
    seq: 2,
    projects: [
      project,
      { ...project, id: "research", name: "Research", demo: 1 },
    ],
    items: [{ ...goal, project_id: "research", demo: 1 }],
    dependencies: [],
    onboarding: { ...emptyOnboarding, hasItems: true, hasDemoData: true },
  });
  await act(async () =>
    socket.receive({ type: "ACK", seq: 3, requestId: load.requestId }),
  );
  expect(
    screen.queryByRole("heading", { name: "Set up your workspace" }),
  ).toBeNull();
  const projects = within(
    screen.getByRole("group", { name: "Visible projects" }),
  );
  expect(projects.getByRole("button", { name: /Research.*Demo/ })).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Radar" }))
      .getByRole("button", { name: goal.title })
      .getAttribute("aria-description"),
  ).toContain("Demo");

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const settings = within(screen.getByRole("dialog", { name: "Settings" }));
  fireEvent.click(settings.getByRole("button", { name: "Remove demo data" }));
  const remove = socket.latestRequest();
  expect(remove.type).toBe("REMOVE_DEMO_DATA");
  socket.receive({
    type: "CANVAS_REPLACE",
    seq: 4,
    projects: [project],
    items: [],
    dependencies: [],
    onboarding: emptyOnboarding,
  });
  await act(async () =>
    socket.receive({ type: "ACK", seq: 5, requestId: remove.requestId }),
  );
  expect(projects.queryByRole("button", { name: /Research/ })).toBeNull();
});
