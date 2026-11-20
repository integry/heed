import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ItemOperationResult } from "../shared/item-operations";
import type { SocketMessage, SocketRequest } from "../shared/workspace-socket";
import type { Project } from "../shared/workspace";
import worker from "./index";
import { issueSession } from "./session";
import { getWorkspaceStub } from "./workspace";

const origin = "https://heed.test";
const secret = "test-session-secret";
const human = { kind: "human" } as const;
const sockets: WebSocket[] = [];
let cookie: string;
let workspaceId: string;
let workspace: ReturnType<typeof getWorkspaceStub>;
const getByName = vi.fn(() => workspace);
const bindings = {
  ...env,
  SESSION_SECRET: secret,
  WORKSPACE: { getByName } as unknown as Env["WORKSPACE"],
  TOKEN_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

beforeEach(async () => {
  workspaceId = crypto.randomUUID();
  workspace = getWorkspaceStub(env, workspaceId);
  getByName.mockClear();
  cookie = (await issueSession("human@example.test", secret)).split(";")[0];
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close(1000);
});

function request(
  path: string,
  method = "GET",
  body?: object,
  headers?: HeadersInit,
) {
  return worker.fetch(
    new Request(new URL(path, origin), {
      method,
      headers: headers ?? {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
    }),
    bindings,
  );
}

async function addItem(title: string, parent_id?: string) {
  const response = await request("/api/items", "POST", { title, parent_id });
  expect(response.status).toBe(201);
  return (await response.json<ItemOperationResult>()).item_id;
}

async function connect() {
  const response = await request("/ws", "GET", undefined, {
    Cookie: cookie,
    Origin: origin,
    Upgrade: "websocket",
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  sockets.push(socket);
  const messages = new ReadableStream<string>({
    start(controller) {
      socket.addEventListener("message", (event) =>
        controller.enqueue(event.data as string),
      );
    },
  }).getReader();
  socket.accept();
  let seq = 0;
  return {
    raw: async () => (await messages.read()).value!,
    async next() {
      const message = JSON.parse(
        (await messages.read()).value!,
      ) as SocketMessage;
      expect(message.seq).toBe(++seq);
      return message;
    },
    send(message: SocketRequest) {
      socket.send(JSON.stringify(message));
    },
    socket,
  };
}

it("refuses upgrades without a signed session and same origin before looking up the workspace", async () => {
  for (const [headers, status] of [
    [{ Origin: origin }, 401],
    [{ Origin: origin, Cookie: cookie + "invalid" }, 401],
    [{ Origin: "https://other.test", Cookie: cookie }, 403],
    [{ Cookie: cookie }, 403],
  ] as const) {
    const response = await request("/ws", "GET", undefined, {
      Upgrade: "websocket",
      ...headers,
    });
    expect(response.status).toBe(status);
    expect(response.webSocket).toBeNull();
  }
  expect((await request("/ws")).status).toBe(426);
  expect(getByName).not.toHaveBeenCalled();
});

it("snapshots open items and 24-hour ghosts with counts from older history", async () => {
  const parent = await addItem("Parent");
  const open = await addItem("Open", parent);
  const ghost = await addItem("Recent completion", parent);
  const old = await addItem("Old completion", parent);
  const cancelled = await addItem("Cancelled", parent);
  await workspace.reportProgress(human, { item_id: ghost, status: "done" });
  await workspace.reportProgress(human, { item_id: old, status: "done" });
  await workspace.reportProgress(human, {
    item_id: cancelled,
    status: "cancelled",
  });
  await runInDurableObject(workspace, (_instance, state) => {
    // Cover the SQLite datetime format as well as the ISO timestamps used by mutations.
    state.storage.sql.exec(
      "UPDATE items SET completed_at = datetime('now', '-25 hours') WHERE id = ?",
      old,
    );
  });
  await workspace.setGuidance(human, "Focus on billing.");
  await workspace.setTimezone("Europe/Tallinn");
  await workspace.setDependency(human, {
    item_id: parent,
    blocked_by_id: open,
    action: "add",
  });

  const client = await connect();
  const snapshot = await client.next();
  expect(snapshot.type).toBe("SNAPSHOT");
  if (snapshot.type !== "SNAPSHOT") throw new Error("Expected snapshot");
  expect(snapshot.settings).toMatchObject({
    guidance: "Focus on billing.",
    timezone: "Europe/Tallinn",
  });
  expect(snapshot.projects).toMatchObject([{ id: "inbox" }]);
  expect(snapshot.items.map(({ id }) => id).sort()).toEqual(
    [parent, open, ghost].sort(),
  );
  expect(snapshot.items.find(({ id }) => id === parent)?.progress).toEqual({
    done: 2,
    total: 3,
  });
  expect(snapshot.dependencies).toEqual([
    { item_id: parent, blocked_by_id: open },
  ]);
});

it("broadcasts MCP, human HTTP and report changes to both sockets across hibernation", async () => {
  const { token } = await workspace.createToken("Builder");
  const authorization = token.replace(`heed_${workspaceId}_`, "heed_default_");
  const agentHeaders = {
    Authorization: `Bearer ${authorization}`,
    "Content-Type": "application/json",
  };
  const first = await connect();
  const second = await connect();
  expect(await first.next()).toMatchObject({ type: "SNAPSHOT" });
  expect(await second.next()).toMatchObject({ type: "SNAPSHOT" });
  await evictDurableObject(workspace);
  first.socket.send("ping");
  expect(await first.raw()).toBe("pong");

  const response = await request(
    "/mcp",
    "POST",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_item",
        arguments: { title: "From MCP", status: "active" },
      },
    },
    { ...agentHeaders, Accept: "application/json, text/event-stream" },
  );
  expect(response.status).toBe(200);
  const {
    result: {
      structuredContent: { item_id },
    },
  } = await response.json<{
    result: { structuredContent: { item_id: string } };
  }>();
  const upsert = await first.next();
  expect(upsert).toMatchObject({
    type: "ITEM_UPSERT",
    item: { id: item_id, title: "From MCP" },
  });
  expect(await second.next()).toEqual(upsert);

  const child = await addItem("From HTTP", item_id);
  for (const client of [first, second]) {
    expect(await client.next()).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: child, title: "From HTTP" },
    });
    expect(await client.next()).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: item_id, progress: { done: 0, total: 1 } },
    });
  }

  const previous = new Date(Date.now() - 60_000).toISOString();
  await runInDurableObject(workspace, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE items SET last_heartbeat_at = ? WHERE id = ?",
      previous,
      item_id,
    );
  });
  const report = await request(
    "/api/report",
    "POST",
    { item_id },
    agentHeaders,
  );
  expect(report.status).toBe(200);
  expect((await report.json<ItemOperationResult>()).items).toEqual([]);
  for (const client of [first, second]) {
    const message = await client.next();
    expect(message).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: item_id },
    });
    if (message.type !== "ITEM_UPSERT")
      throw new Error("Expected heartbeat upsert");
    expect(Date.parse(message.item.last_heartbeat_at!)).toBeGreaterThan(
      Date.parse(previous),
    );
  }
  first.send({ type: "GET_SNAPSHOT" });
  const snapshot = await first.next();
  if (snapshot.type !== "SNAPSHOT") throw new Error("Expected snapshot");
  expect(
    snapshot.items.find(({ id }) => id === item_id)?.last_heartbeat_at,
  ).toBe(previous);
});

it("applies human edits and status changes, then replies only to the requesting socket", async () => {
  const originalParent = await addItem("Original parent");
  const newParent = await addItem("New parent");
  const item = await addItem("Work", originalParent);
  const first = await connect();
  const second = await connect();
  await first.next();
  await second.next();

  first.send({
    type: "UPDATE_ITEM",
    requestId: "drop",
    input: {
      item_id: item,
      parent_id: newParent,
      sort_key: 1.5,
      scheduled_on: "2026-11-20",
      layout_pos: { radar: { radius: 0.5 } },
    },
  });
  for (const client of [first, second]) {
    expect(await client.next()).toMatchObject({
      type: "ITEM_UPSERT",
      item: {
        id: item,
        parent_id: newParent,
        sort_key: 1.5,
        scheduled_on: "2026-11-20",
        layout_pos: '{"radar":{"radius":0.5}}',
        locked_fields: '["scheduled_on","sort_key","layout_pos"]',
      },
    });
    expect(await client.next()).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: originalParent, progress: { done: 0, total: 0 } },
    });
    expect(await client.next()).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: newParent, progress: { done: 0, total: 1 } },
    });
  }
  expect(await first.next()).toMatchObject({ type: "ACK", requestId: "drop" });

  first.send({
    type: "SET_STATUS",
    requestId: "done",
    input: { item_id: item, status: "done" },
  });
  for (const client of [first, second]) {
    expect(await client.next()).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: item, status: "done" },
    });
    expect(await client.next()).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: newParent, progress: { done: 1, total: 1 } },
    });
  }
  expect(await first.next()).toMatchObject({ type: "ACK", requestId: "done" });
  expect(await workspace.getItemEvents({ item_id: item })).toContainEqual(
    expect.objectContaining({ actor: "human", kind: "status" }),
  );

  first.send({
    type: "SET_STATUS",
    requestId: "invalid-transition",
    input: { item_id: item, status: "active" },
  });
  expect(await first.next()).toMatchObject({
    type: "ERROR",
    requestId: "invalid-transition",
    error: { code: "conflict" },
  });
  first.socket.send(
    JSON.stringify({
      type: "UPDATE_ITEM",
      requestId: "invalid-edit",
      input: { item_id: item, priority: 11 },
    }),
  );
  expect(await first.next()).toMatchObject({
    type: "ERROR",
    requestId: "invalid-edit",
    error: { code: "invalid_input" },
  });

  first.send({
    type: "SET_STATUS",
    requestId: "cancel",
    input: { item_id: item, status: "cancelled" },
  });
  for (const client of [first, second]) {
    expect(await client.next()).toMatchObject({
      type: "ITEM_REMOVE",
      item_id: item,
    });
    expect(await client.next()).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: newParent, progress: { done: 0, total: 0 } },
    });
  }
  expect(await first.next()).toMatchObject({
    type: "ACK",
    requestId: "cancel",
  });
});

it("broadcasts project, settings and dependency updates including cascades on deletion", async () => {
  const parent = await addItem("Parent");
  const child = await addItem("Child", parent);
  const blocker = await addItem("Blocker");
  const dependency = { item_id: child, blocked_by_id: blocker };
  const client = await connect();
  await client.next();

  const result = await request("/api/projects", "POST", { name: "Operations" });
  expect(result.status).toBe(201);
  const project = await result.json<Project>();
  expect(await client.next()).toMatchObject({
    type: "PROJECT_UPSERT",
    project,
  });
  expect(
    (await request(`/api/projects/${project.id}`, "PATCH", { hidden: true }))
      .status,
  ).toBe(400);
  expect(
    (await request(`/api/projects/${project.id}`, "PATCH", { hidden: 1 }))
      .status,
  ).toBe(200);
  expect(await client.next()).toMatchObject({
    type: "PROJECT_UPSERT",
    project: { id: project.id, hidden: 1 },
  });
  expect((await request(`/api/projects/${project.id}`, "DELETE")).status).toBe(
    200,
  );
  expect(await client.next()).toMatchObject({
    type: "PROJECT_REMOVE",
    project_id: project.id,
  });

  expect(
    (
      await request("/api/settings/guidance", "PUT", {
        text: "Prioritize billing.",
      })
    ).status,
  ).toBe(200);
  expect(await client.next()).toMatchObject({
    type: "SETTINGS_UPDATE",
    settings: { guidance: "Prioritize billing." },
  });
  expect(
    (
      await request("/api/settings/timezone", "PUT", {
        timezone: "Europe/Tallinn",
      })
    ).status,
  ).toBe(200);
  expect(await client.next()).toMatchObject({
    type: "SETTINGS_UPDATE",
    settings: { timezone: "Europe/Tallinn" },
  });

  expect((await request("/api/dependencies", "POST", dependency)).status).toBe(
    200,
  );
  expect(await client.next()).toMatchObject({
    type: "DEPENDENCY_ADD",
    dependency,
  });
  expect(
    (await request("/api/dependencies", "DELETE", dependency)).status,
  ).toBe(200);
  expect(await client.next()).toMatchObject({
    type: "DEPENDENCY_REMOVE",
    dependency,
  });
  expect((await request("/api/dependencies", "POST", dependency)).status).toBe(
    200,
  );
  expect(await client.next()).toMatchObject({
    type: "DEPENDENCY_ADD",
    dependency,
  });
  expect((await request(`/api/items/${parent}`, "DELETE")).status).toBe(200);
  expect(await client.next()).toMatchObject({
    type: "DEPENDENCY_REMOVE",
    dependency,
  });
  expect(await client.next()).toMatchObject({
    type: "ITEM_REMOVE",
    item_id: parent,
  });
  expect(await client.next()).toMatchObject({
    type: "ITEM_REMOVE",
    item_id: child,
  });
});

it("shares project and guidance edits across sockets and initializes the timezone only once", async () => {
  const first = await connect();
  const second = await connect();
  for (const client of [first, second]) {
    expect(await client.next()).toMatchObject({
      type: "SNAPSHOT",
      timezoneConfigured: false,
      settings: { timezone: "UTC" },
    });
  }

  first.send({
    type: "INITIALIZE_TIMEZONE",
    requestId: "first-zone",
    input: { timezone: "UTC" },
  });
  for (const client of [first, second]) {
    expect(await client.next()).toMatchObject({
      type: "SETTINGS_UPDATE",
      settings: { timezone: "UTC" },
    });
  }
  expect(await first.next()).toMatchObject({
    type: "ACK",
    requestId: "first-zone",
  });

  second.send({
    type: "INITIALIZE_TIMEZONE",
    requestId: "second-zone",
    input: { timezone: "Europe/Tallinn" },
  });
  expect(await second.next()).toMatchObject({
    type: "ACK",
    requestId: "second-zone",
  });
  second.send({ type: "GET_SNAPSHOT" });
  expect(await second.next()).toMatchObject({
    type: "SNAPSHOT",
    timezoneConfigured: true,
    settings: { timezone: "UTC" },
  });

  first.send({
    type: "UPDATE_PROJECT",
    requestId: "hide",
    project_id: "inbox",
    input: { hidden: 1 },
  });
  for (const client of [first, second]) {
    expect(await client.next()).toMatchObject({
      type: "PROJECT_UPSERT",
      project: { id: "inbox", hidden: 1 },
    });
  }
  expect(await first.next()).toMatchObject({ type: "ACK", requestId: "hide" });

  second.send({
    type: "SET_GUIDANCE",
    requestId: "guidance",
    input: { text: "Focus on billing." },
  });
  for (const client of [first, second]) {
    expect(await client.next()).toMatchObject({
      type: "SETTINGS_UPDATE",
      settings: { guidance: "Focus on billing." },
    });
  }
  expect(await second.next()).toMatchObject({
    type: "ACK",
    requestId: "guidance",
  });
});

it("reopens an older item through the shared operation and publishes it to the canvas", async () => {
  const item_id = await addItem("Investigate regression");
  await workspace.reportProgress(human, { item_id, status: "cancelled" });
  const client = await connect();
  expect(await client.next()).toMatchObject({ type: "SNAPSHOT", items: [] });

  client.send({
    type: "REOPEN_ITEM",
    requestId: "reopen",
    input: { item_id, reason: "Regression returned" },
  });
  expect(await client.next()).toMatchObject({
    type: "ITEM_UPSERT",
    item: {
      id: item_id,
      status: "queued",
      reopen_count: 1,
      reopen_reason: "Regression returned",
    },
  });
  expect(await client.next()).toMatchObject({
    type: "ACK",
    requestId: "reopen",
  });
  expect(await (await request("/api/history")).json()).toMatchObject({
    items: [],
  });
});

it("rolls back a reorder batch if a row disappears before the drop", async () => {
  const item_id = await addItem("Existing item");
  const client = await connect();
  await client.next();
  client.send({
    type: "REORDER_ITEMS",
    requestId: "reorder",
    input: [
      { item_id, sort_key: 1 },
      { item_id: "missing", sort_key: 2 },
    ],
  });
  expect(await client.next()).toMatchObject({
    type: "ERROR",
    requestId: "reorder",
  });
  client.send({ type: "GET_SNAPSHOT" });
  expect(await client.next()).toMatchObject({
    type: "SNAPSHOT",
    items: [{ id: item_id, sort_key: null }],
  });
});
