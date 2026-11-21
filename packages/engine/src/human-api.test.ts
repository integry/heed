import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  INBOX_PROJECT_ID,
  RESET_WORKSPACE_CONFIRMATION,
  WORKSPACE_RESET_CLOSE_CODE,
} from "@heedwork/core";
import type { HistoryPage } from "@heedwork/core";
import type { ItemOperationResult } from "@heedwork/core";
import type { Event, Guidance, Project, TokenMetadata } from "@heedwork/core";
import { fetchOpen } from "./worker-test-helpers";
import { issueSession } from "./auth";
import { hashSecret, tokenParts } from "./token-secrets";
import type { PushEnv } from "./web-push";
import { getWorkspaceStub } from "./workspace";

const origin = "https://heed.test";
const secret = "test-session-secret";
let cookie: string;
let workspaceId: string;
let workspace: ReturnType<typeof getWorkspaceStub>;
const getByName = vi.fn(() => workspace);
const bindings = {
  ...(env as Env & PushEnv),
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

async function request(
  path: string,
  method = "GET",
  body?: object,
  headers?: HeadersInit,
) {
  return fetchOpen(
    new Request(new URL(path, origin), {
      method,
      headers: headers ?? {
        Cookie: cookie,
        ...(method !== "GET" && { Origin: origin }),
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    }),
    bindings,
  );
}

async function json<T>(response: Response, status = 200) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  return response.json<T>();
}

async function error(response: Response, status: number, code: string) {
  expect(await json(response, status)).toEqual({
    error: { code, message: expect.any(String) },
  });
}

async function addItem(title: string, fields: object = {}) {
  return (
    await json<ItemOperationResult>(
      await request("/api/items", "POST", { title, ...fields }),
      201,
    )
  ).items[0];
}

async function authorizeApp(name: string) {
  const csrf = crypto.randomUUID();
  const userId = "human@example.test";
  const resource = `${origin}/mcp`;
  await workspace.beginOAuthConsent(csrf, userId, {
    client: {
      id: "client",
      name,
      authMethod: "none",
      secretHash: null,
      refresh: false,
    },
    redirectUri: "https://client.example.test/callback",
    challenge: await hashSecret("test-verifier"),
    resource,
    state: null,
  });
  const grant = await workspace.finishOAuthConsent(csrf, userId, resource, {
    label: name,
    scope: "report",
  });
  expect(grant?.code).toEqual(expect.any(String));
}

function withoutDemo<T extends { demo?: number }>(record: T): Omit<T, "demo"> {
  const fields = { ...record };
  delete fields.demo;
  return fields;
}

it("requires a signed session and a same-origin mutation before looking up the workspace", async () => {
  const sessionResponse = await request("/api/me", "GET", undefined, {});
  expect(sessionResponse.status).toBe(401);
  expect(await sessionResponse.json()).toMatchObject({
    error: { code: "unauthorized", message: expect.any(String) },
    devLoginEnabled: false,
  });
  for (const path of [
    "/api/settings",
    "/api/export",
    "/api/projects",
    "/api/tokens",
    "/api/history",
    "/api/items/id/events",
  ]) {
    await error(await request(path, "GET", undefined, {}), 401, "unauthorized");
  }
  for (const [method, path] of [
    ["POST", "/api/command"],
    ["POST", "/api/reset"],
    ["POST", "/api/transcribe"],
    ["POST", "/api/items"],
    ["PATCH", "/api/items/id"],
    ["POST", "/api/items/id/status"],
    ["POST", "/api/items/id/handoff"],
    ["POST", "/api/items/id/reopen"],
    ["DELETE", "/api/items/id"],
    ["POST", "/api/dependencies"],
    ["DELETE", "/api/dependencies"],
    ["POST", "/api/projects"],
    ["PATCH", "/api/projects/id"],
    ["DELETE", "/api/projects/id"],
    ["PUT", "/api/settings/timezone"],
    ["PUT", "/api/settings/guidance"],
    ["POST", "/api/tokens"],
    ["DELETE", "/api/tokens/id"],
  ]) {
    await error(
      await request(path, method, undefined, { Origin: origin }),
      401,
      "unauthorized",
    );
    await error(
      await request(path, method, undefined, {
        Cookie: cookie,
        Origin: "https://foreign.test",
      }),
      403,
      "forbidden_origin",
    );
  }
  await error(
    await request("/api/items", "POST", undefined, { Cookie: cookie }),
    403,
    "forbidden_origin",
  );
  expect(getByName).not.toHaveBeenCalled();
  await json(await request("/api/settings"));
  expect(getByName).toHaveBeenCalledWith("default");
});

it("exports workspace data and history without credentials or internal settings", async () => {
  const project = await workspace.createProject({ name: "Archive", hidden: 1 });
  const active = await addItem('Release "α"');
  const archived = await addItem("Archived", {
    project: project.id,
    status: "cancelled",
  });
  const blocker = await addItem("Blocker");
  await workspace.setDependency(
    { kind: "human" },
    {
      item_id: active.id,
      blocked_by_id: blocker.id,
      action: "add",
    },
  );
  await workspace.setTimezone("Europe/Tallinn");
  await workspace.setGuidance({ kind: "human" }, "Review before merging.");
  const token = await workspace.createToken("Private token label");
  await authorizeApp("private-grant");
  await runInDurableObject(workspace, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO push_subscriptions (endpoint, keys) VALUES ('private-endpoint', 'private-keys')",
    );
    state.storage.sql.exec(
      "INSERT INTO settings VALUES ('command_undo', 'private-undo')",
    );
  });

  const response = await request("/api/export");
  expect(response.headers.get("Content-Disposition")).toBe(
    'attachment; filename="heed-workspace.json"',
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.status).toBe(200);
  const body = await response.text();
  const data = JSON.parse(body);
  expect(data).toEqual({
    format_version: 1,
    settings: {
      timezone: "Europe/Tallinn",
      guidance: "Review before merging.",
      guidance_updated_at: expect.any(String),
    },
    projects: expect.arrayContaining([
      expect.objectContaining({ id: INBOX_PROJECT_ID }),
      withoutDemo(project),
    ]),
    items: expect.arrayContaining([active, archived, blocker].map(withoutDemo)),
    dependencies: [{ item_id: active.id, blocked_by_id: blocker.id }],
    events: expect.arrayContaining(
      await workspace.getItemEvents({ item_id: active.id }),
    ),
  });
  expect(data.items).toHaveLength(3);
  expect(data.events.length).toBeGreaterThan(2);
  for (const secret of [
    token.token,
    token.label,
    token.id,
    "secret_hash",
    "private-endpoint",
    "private-keys",
    "private-grant",
    "private-undo",
  ]) {
    expect(body).not.toContain(secret);
  }
});

it("fails an interrupted export instead of mixing old and new data", async () => {
  await runInDurableObject(workspace, async (instance) => {
    const reader = instance.exportWorkspace().getReader();
    expect((await reader.read()).done).toBe(false);
    instance.createProject({ name: "Changed after export started" });
    await expect(async () => {
      while (!(await reader.read()).done) {
        // The stream may already have queued a chunk before the change.
      }
    }).rejects.toThrow("The workspace changed during export.");
  });
});

it("streams a JSON export larger than the Worker memory budget in bounded chunks", async () => {
  await runInDurableObject(workspace, (_instance, { storage }) => {
    storage.sql.exec(`
      WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < 4400)
      INSERT INTO items (id, project_id, title, tags)
      SELECT 'item-' || i, 'inbox', 'Fixture ' || i,
        '["' || hex(zeroblob(16384)) || '"]' FROM n
    `);
  });
  const response = await request("/api/export");
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let first = "";
  let last = "";
  let itemCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (bytes === 0) first = text;
    bytes += value.length;
    if (value.length > 128 * 1024) throw new Error("Oversized export chunk");
    itemCount += text.split('"title":"Fixture ').length - 1;
    last = (last + text).slice(-100);
  }
  expect(first).toMatch(/^\{"format_version":1,"settings":/);
  expect(last).toMatch(/\],"dependencies":\[\],"events":\[\]\}$/);
  expect(bytes).toBeGreaterThan(128 * 1024 * 1024);
  expect(itemCount).toBe(4400);
}, 20_000);

it("requires exact confirmation and resets storage, sockets and agent access", async () => {
  const defaultSettings = await workspace.getSettings();
  const item = await addItem("Remove me");
  const { token } = await workspace.createToken("Before reset");
  await workspace.setTimezone("Europe/Tallinn");
  await workspace.setGuidance({ kind: "human" }, "Remove me too");
  await authorizeApp("Old app");
  await runInDurableObject(workspace, async (_instance, { storage }) => {
    await storage.put("grant", "old grant");
    storage.sql.exec(
      "INSERT INTO push_subscriptions (endpoint, keys) VALUES ('old-endpoint', 'old-keys')",
    );
  });

  const report = () =>
    request(
      "/api/report",
      "POST",
      { item_id: item.id, note: "Agent report" },
      {
        Authorization: `Bearer heed_default_${tokenParts(token)!.secret}`,
        "Content-Type": "application/json",
      },
    );
  expect((await report()).status).toBe(200);
  await error(
    await request("/api/reset", "POST", { confirmation: "reset workspace" }),
    400,
    "invalid_input",
  );
  expect((await workspace.getItem({ item_id: item.id })).title).toBe(
    "Remove me",
  );

  const upgrade = await request("/ws", "GET", undefined, {
    Cookie: cookie,
    Origin: origin,
    Upgrade: "websocket",
  });
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket!;
  onTestFinished(() => socket.close());
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", ({ code }) => resolve(code), {
      once: true,
    }),
  );
  socket.accept();
  await expect(
    json(
      await request("/api/reset", "POST", {
        confirmation: RESET_WORKSPACE_CONFIRMATION,
      }),
    ),
  ).resolves.toEqual({ ok: true });
  expect(await closed).toBe(WORKSPACE_RESET_CLOSE_CODE);

  expect(await workspace.getSettings()).toEqual(defaultSettings);
  expect(await workspace.listProjects()).toEqual([
    {
      id: INBOX_PROJECT_ID,
      name: "Inbox",
      color: null,
      hidden: 0,
      sort: 0,
      demo: 0,
    },
  ]);
  expect(await workspace.listTokens()).toEqual([]);
  expect((await report()).status).toBe(401);
  const empty = await json<{ items: unknown[]; events: unknown[] }>(
    await request("/api/export"),
  );
  expect(empty.items).toEqual([]);
  expect(empty.events).toEqual([]);
  await runInDurableObject(workspace, async (_instance, { storage }) => {
    expect(await storage.get("grant")).toBeUndefined();
    expect(storage.sql.exec("SELECT * FROM oauth_grants").toArray()).toEqual(
      [],
    );
    expect(
      storage.sql.exec("SELECT * FROM push_subscriptions").toArray(),
    ).toEqual([]);
  });
  expect((await addItem("Fresh item")).project_id).toBe(INBOX_PROJECT_ID);
});

it("creates, edits, unlocks and hard-deletes items as a human", async () => {
  await error(await request("/api/items", "POST"), 400, "invalid_input");
  await error(
    await request("/api/items", "POST", { title: "Test", priority: 0 }),
    400,
    "invalid_input",
  );

  const project = await workspace.createProject({ name: "Delivery" });
  const item = await addItem("Initial", {
    priority: 6,
    scheduled_on: "2026-11-20",
  });
  expect(item.created_by).toBe("human");
  expect(JSON.parse(item.locked_fields)).toEqual(["priority", "scheduled_on"]);
  const child = await addItem("Child", { parent_id: item.id });
  const path = `/api/items/${item.id}`;
  const layout_pos = { radar: { angle: 0.3, radius: 0.6 } };
  const patch = await json<ItemOperationResult>(
    await request(path, "PATCH", {
      title: "Updated",
      project: project.id,
      hidden: true,
      sort_key: 2.5,
      layout_pos,
    }),
  );
  expect(patch.items).toMatchObject([
    {
      id: item.id,
      title: "Updated",
      project_id: project.id,
      hidden: 1,
      sort_key: 2.5,
      layout_pos: JSON.stringify(layout_pos),
      locked_fields: JSON.stringify([
        "priority",
        "scheduled_on",
        "sort_key",
        "layout_pos",
      ]),
    },
    { id: child.id, project_id: project.id },
  ]);

  const reporter = {
    kind: "agent",
    scope: "report",
    name: "Reporter",
  } as const;
  const priorityUpdate = { item_id: item.id, priority: 8 };
  expect(
    (await workspace.updateItem(reporter, priorityUpdate)).ignored_fields,
  ).toEqual(["priority"]);
  await json(await request(path, "PATCH", { unlock: "priority" }));
  expect(
    (await workspace.updateItem(reporter, priorityUpdate)).items[0].priority,
  ).toBe(8);

  const deleted = await json<ItemOperationResult>(
    await request(path, "DELETE"),
  );
  expect(deleted.items.map(({ id }) => id)).toEqual([item.id, child.id]);
  await error(
    await request(path, "PATCH", { title: "Missing" }),
    404,
    "not_found",
  );
  await error(await request(`/api/items/${child.id}/events`), 404, "not_found");
});

it("changes status, sets and clears a handoff, reopens, and reads the item timeline", async () => {
  const item = await addItem("Follow up");
  const path = `/api/items/${item.id}`;
  await error(
    await request(`${path}/status`, "POST", {}),
    400,
    "invalid_input",
  );
  await error(
    await request(`${path}/handoff`, "POST", {
      clear: true,
      note: "Ambiguous",
    }),
    400,
    "invalid_input",
  );
  await error(
    await request(`${path}/reopen`, "POST", { reason: "Early" }),
    409,
    "conflict",
  );

  const handoff = await json<ItemOperationResult>(
    await request(`${path}/handoff`, "POST", { note: "Review the change" }),
  );
  expect(handoff.items[0]).toMatchObject({
    handoff: 1,
    handoff_note: "Review the change",
  });
  const cleared = await json<ItemOperationResult>(
    await request(`${path}/handoff`, "POST", { clear: true }),
  );
  expect(cleared.items[0]).toMatchObject({ handoff: 0, handoff_note: null });

  await json(
    await request(`${path}/status`, "POST", {
      status: "done",
      note: "Complete",
    }),
  );
  await error(
    await request(`${path}/status`, "POST", { status: "active" }),
    409,
    "conflict",
  );
  const reopened = await json<ItemOperationResult>(
    await request(`${path}/reopen`, "POST", { reason: "Regression" }),
  );
  expect(reopened.items[0]).toMatchObject({
    status: "queued",
    reopen_count: 1,
    reopen_reason: "Regression",
    completed_at: null,
  });
  const events = await json<Event[]>(await request(`${path}/events`));
  expect(events.map(({ kind }) => kind)).toEqual([
    "moved",
    "reopened",
    "status",
    "note",
    "status",
    "handoff",
    "handoff",
    "created",
  ]);
  expect(events).toEqual(
    events.map((event) => ({
      ...event,
      item_id: item.id,
      actor: {
        id: "human@example.test",
        email: "human@example.test",
        name: "human@example.test",
      },
    })),
  );
});

it("adds and removes dependencies, and reports invalid or conflicting edges", async () => {
  const first = await addItem("Build");
  const second = await addItem("Deploy");
  const path = "/api/dependencies";
  const edge = { item_id: second.id, blocked_by_id: first.id };
  await error(
    await request(path, "POST", { ...edge, blocked_by_id: second.id }),
    400,
    "invalid_input",
  );
  expect(await json(await request(path, "POST", edge))).toMatchObject({
    dependency: { ...edge, action: "add" },
  });
  await error(
    await request(path, "POST", {
      item_id: first.id,
      blocked_by_id: second.id,
    }),
    409,
    "conflict",
  );
  expect(await json(await request(path, "DELETE", edge))).toMatchObject({
    dependency: { ...edge, action: "remove" },
  });
  expect(await workspace.listDependencies()).toEqual([]);
});

it("lists, creates, edits and deletes projects with the workspace safeguards", async () => {
  const path = "/api/projects";
  expect(await json<Project[]>(await request(path))).toMatchObject([
    { id: "inbox" },
  ]);
  const project = await json<Project>(
    await request(path, "POST", { name: "Launch" }),
    201,
  );
  await error(await request(path, "POST", { name: "Launch" }), 409, "conflict");
  const projectPath = `${path}/${project.id}`;
  const edited = { name: "Release", hidden: 1, color: "#0088aa", sort: 3 };
  expect(await json(await request(projectPath, "PATCH", edited))).toMatchObject(
    edited,
  );
  const item = await addItem("Deploy", { project: project.id });
  await error(await request(projectPath, "DELETE"), 409, "conflict");
  await error(await request(`${path}/inbox`, "DELETE"), 409, "conflict");
  await json(await request(`/api/items/${item.id}`, "DELETE"));
  expect(await json(await request(projectPath, "DELETE"))).toEqual({
    ok: true,
  });
  await error(await request(projectPath, "DELETE"), 404, "not_found");
});

it("reads settings and validates timezone and guidance changes", async () => {
  const path = "/api/settings";
  expect(await json(await request(path))).toMatchObject({
    timezone: "UTC",
    guidance: "",
  });
  await error(
    await request(`${path}/timezone`, "PUT", { timezone: "+05:00" }),
    400,
    "invalid_input",
  );
  expect(
    await json(
      await request(`${path}/timezone`, "PUT", { timezone: "Europe/Tallinn" }),
    ),
  ).toEqual({ timezone: "Europe/Tallinn" });
  await error(
    await request(`${path}/guidance`, "PUT", { text: "a".repeat(2001) }),
    400,
    "invalid_input",
  );
  const guidance = await json<Guidance>(
    await request(`${path}/guidance`, "PUT", { text: "Prioritize billing" }),
  );
  expect(guidance).toEqual({
    guidance: "Prioritize billing",
    guidance_updated_at: expect.any(String),
  });
  expect(await json(await request(path))).toMatchObject({
    ...guidance,
    timezone: "Europe/Tallinn",
  });
});

it("shows token plaintext once and revokes tokens by ID", async () => {
  const path = "/api/tokens";
  await error(
    await request(path, "POST", {
      label: "Agent",
      default_project_id: "missing",
    }),
    400,
    "invalid_input",
  );
  const response = await request(path, "POST", {
    label: "Agent",
    default_project_id: "inbox",
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const { token, ...metadata } = await json<TokenMetadata & { token: string }>(
    response,
    201,
  );
  const prefix = `heed_${workspaceId}_`;
  expect(token.startsWith(prefix)).toBe(true);
  expect(metadata).toMatchObject({
    label: "Agent",
    scope: "report",
    default_project_id: "inbox",
  });
  expect(await json(await request(path))).toEqual([metadata]);
  const tokenSecret = token.slice(prefix.length);
  expect(await workspace.verifyToken(tokenSecret)).not.toBeNull();
  expect(await json(await request(`${path}/${metadata.id}`, "DELETE"))).toEqual(
    { ok: true },
  );
  expect(await json(await request(path))).toEqual([]);
  expect(await workspace.verifyToken(tokenSecret)).toBeNull();
  await error(
    await request(`${path}/${metadata.id}`, "DELETE"),
    404,
    "not_found",
  );
});

it("searches and pages terminal items newest first without skipping equal timestamps", async () => {
  const project = await workspace.createProject({ name: "Billing" });
  const billing = { project: project.id };
  const first = await addItem("Invoice reminder", {
    ...billing,
    status: "done",
  });
  const second = await addItem("Follow-up", {
    ...billing,
    status: "cancelled",
    note: "Invoice follow-up",
  });
  const older = await addItem("Old invoice", { ...billing, status: "done" });
  await addItem("Open invoice", billing);
  await addItem("Completed invoice in Inbox", { status: "done" });
  await addItem("Other work", { ...billing, status: "done" });
  const newerAt = "2020-05-02T12:00:00.000Z";
  const olderAt = "2020-05-01T12:00:00.000Z";
  await runInDurableObject(workspace, (_, { storage: { sql } }) => {
    sql.exec(
      "UPDATE items SET completed_at = ? WHERE id = ?",
      newerAt,
      first.id,
    );
    sql.exec(
      "UPDATE items SET updated_at = ? WHERE id = ?",
      newerAt,
      second.id,
    );
    sql.exec(
      "UPDATE items SET completed_at = ? WHERE id = ?",
      "2020-05-01 12:00:00",
      older.id,
    );
  });

  const search = new URLSearchParams({
    q: "INVOICE",
    project: project.id,
    limit: "1",
  });
  const readPage = () =>
    request(`/api/history?${search}`).then((response) =>
      json<HistoryPage>(response),
    );
  const expected = [first.id, second.id].sort();
  for (const [id, at] of [
    [expected[0], newerAt],
    [expected[1], newerAt],
    [older.id, olderAt],
  ]) {
    const page = await readPage();
    expect(page.items).toMatchObject([{ id, history_at: at }]);
    expect(page.items).toHaveLength(1);
    if (id === older.id) {
      expect(page.next_before).toBeNull();
    } else {
      expect(page.next_before).toEqual(expect.any(String));
      search.set("before", page.next_before!);
    }
  }
  search.set("before", newerAt);
  expect((await readPage()).items).toMatchObject([{ id: older.id }]);
  await error(
    await request("/api/history?before=invalid"),
    400,
    "invalid_input",
  );
  await error(await request("/api/history?limit=101"), 400, "invalid_input");
});

it("authenticates and stores one push subscription per endpoint and removes it idempotently", async () => {
  const path = "/api/push/subscribe";
  const statusPath = "/api/push/status";
  const endpoint = "https://fcm.googleapis.com/fcm/send/test-subscription";
  const keys = {
    p256dh:
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  };
  const subscriptions = () =>
    runInDurableObject(workspace, (_, { storage: { sql } }) =>
      sql.exec("SELECT endpoint, keys FROM push_subscriptions").toArray(),
    );
  const status = async (deviceKeys = keys) =>
    json(await request(statusPath, "POST", { endpoint, keys: deviceKeys }));
  await error(
    await request(statusPath, "POST", { endpoint, keys }, { Origin: origin }),
    401,
    "unauthorized",
  );
  await error(
    await request(statusPath, "POST", { endpoint, keys }, { Cookie: cookie }),
    403,
    "forbidden_origin",
  );
  await error(
    await request(path, "POST", { endpoint, keys }, { Origin: origin }),
    401,
    "unauthorized",
  );
  await error(
    await request(path, "DELETE", { endpoint }, { Cookie: cookie }),
    403,
    "forbidden_origin",
  );
  expect(getByName).not.toHaveBeenCalled();
  expect(
    await json(await request("/api/push/key", "GET", undefined, {})),
  ).toEqual({
    publicKey: bindings.VAPID_PUBLIC_KEY,
  });
  expect(getByName).not.toHaveBeenCalled();
  await error(
    await request(path, "POST", { endpoint: "https://localhost/api", keys }),
    400,
    "invalid_input",
  );
  await error(
    await request(path, "POST", { endpoint, keys: { ...keys, auth: "bad" } }),
    400,
    "invalid_input",
  );
  expect(await subscriptions()).toEqual([]);
  expect(await status()).toEqual({ registered: false });
  const updatedKeys = { ...keys, auth: "AAAAAAAAAAAAAAAAAAAAAA" };
  for (const body of [
    { endpoint, keys },
    { endpoint, keys },
    { endpoint, keys: updatedKeys },
  ]) {
    expect(await json(await request(path, "POST", body))).toEqual({ ok: true });
  }
  expect(await subscriptions()).toEqual([
    { endpoint, keys: JSON.stringify(updatedKeys) },
  ]);
  expect(await status()).toEqual({ registered: false });
  expect(await status(updatedKeys)).toEqual({ registered: true });
  for (let index = 0; index < 2; index++) {
    expect(await json(await request(path, "DELETE", { endpoint }))).toEqual({
      ok: true,
    });
  }
  expect(await subscriptions()).toEqual([]);
  expect(await status(updatedKeys)).toEqual({ registered: false });
});
