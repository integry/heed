import {
  createExecutionContext,
  evictDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, onTestFinished, vi } from "vitest";
import { VOICE_SAMPLE_RATE, WAV_HEADER_BYTES } from "@heedwork/core";
import type { Event, ItemOperationResult, SocketMessage } from "@heedwork/core";
import { createApp } from "./index";
import type { AppSeams, UsageEvent } from "./index";
import { issueSession } from "./auth";
import { hostLimits } from "./test-host";
import type { HostedWorkspace } from "./test-host";
import { newTokenSecret, tokenParts } from "./token-secrets";
import { fetchOpen } from "./worker-test-helpers";

const origin = "https://heed.test";
const user = {
  id: "reviewer-1",
  email: "reviewer@example.test",
  name: "Demo Reviewer",
};

function request(
  path: string,
  headers = new Headers(),
  body?: object | ArrayBuffer,
) {
  headers.set("Origin", origin);
  if (body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return new Request(origin + path, {
    headers,
    method: body ? "POST" : "GET",
    body: body instanceof ArrayBuffer ? body : body && JSON.stringify(body),
  });
}

function rpc(token: string, name: string, args: object = {}) {
  return request(
    "/mcp",
    new Headers({
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
    }),
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  );
}

function report(token: string, item_id: string) {
  return request(
    "/api/report",
    new Headers({ Authorization: `Bearer ${token}` }),
    {
      item_id,
      status: "active",
      note: "Started",
    },
  );
}

async function toolResult(response: Response) {
  expect(response.status).toBe(200);
  return (
    await response.json<{
      result: { structuredContent: object; isError?: true };
    }>()
  ).result;
}

async function openSocket(response: Response) {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages = new ReadableStream<SocketMessage>({
    start(controller) {
      socket.addEventListener("message", ({ data }) =>
        controller.enqueue(JSON.parse(data as string) as SocketMessage),
      );
    },
  }).getReader();
  socket.accept();
  onTestFinished(() => socket.close(1000));
  return {
    socket,
    async next() {
      return (await messages.read()).value;
    },
  };
}

function setupHost(limits = hostLimits) {
  const id = crypto.randomUUID();
  const alpha = `alpha_${id}`;
  const beta = `limited_${id}`;
  const suspended = `suspended_${id}`;
  const ids = [alpha, beta, suspended];
  const namespace = (
    env as Env & {
      HOST_WORKSPACE: DurableObjectNamespace<HostedWorkspace>;
    }
  ).HOST_WORKSPACE;
  const getByName = vi.fn((workspaceId: string) =>
    namespace.getByName(workspaceId),
  );
  const configuredProvider = {
    model: "fixture-managed-model",
    next: vi.fn().mockResolvedValue({
      text: "Ready to review.",
      calls: [],
      usage: { inputTokens: 20, outputTokens: 4 },
    }),
  };
  const record = vi
    .fn<AppSeams["usage"]["record"]>()
    .mockResolvedValue(undefined);
  const ctx = createExecutionContext();
  const keys = vi.fn<AppSeams["keys"]["commandProvider"]>(
    async (workspaceId) => ({
      managed: true,
      configuration:
        workspaceId === alpha
          ? {
              command: configuredProvider,
              transcribe: async () => " Review the changes. ",
            }
          : null,
    }),
  );
  const app = createApp({
    auth: {
      async session(request) {
        const workspaceId = request.headers.get("X-Test-Workspace");
        return workspaceId && ids.includes(workspaceId)
          ? { workspaceId, role: "editor", user }
          : null;
      },
      async handleAuthRoute(request) {
        return Response.json({ handled: new URL(request.url).pathname });
      },
      async workspaceForToken(token) {
        const workspaceId = tokenParts(token)?.workspaceId;
        return workspaceId && ids.includes(workspaceId) ? workspaceId : null;
      },
    },
    limits,
    usage: { record },
    keys: { commandProvider: keys },
  });
  return {
    alpha,
    beta,
    suspended,
    record,
    ctx,
    keys,
    configuredProvider,
    getByName,
    workspace: (id: string) => namespace.getByName(id),
    fetch: (request: Request) =>
      app.fetch(
        request,
        {
          ...env,
          WORKSPACE: { getByName } as unknown as Env["WORKSPACE"],
        },
        ctx,
      ),
    human: (
      workspaceId: string,
      path: string,
      body?: object | ArrayBuffer,
      extra?: Record<string, string>,
    ) =>
      request(
        path,
        new Headers({ "X-Test-Workspace": workspaceId, ...extra }),
        body,
      ),
  };
}

it("isolates the hosted human API, hibernating WebSockets, MCP and report by workspace", async () => {
  const host = setupHost();
  const { alpha, beta, suspended, human, fetch, workspace } = host;
  const { token: tokenA } = await workspace(alpha).createToken("Agent A");
  const { token: tokenB } = await workspace(beta).createToken("Agent B");
  const { item_id: itemB } = await workspace(beta).addItem(
    { kind: "human" },
    { title: "Private beta" },
  );
  expect(await (await fetch(human(alpha, "/auth/sign-in"))).json()).toEqual({
    handled: "/auth/sign-in",
  });

  const created = await fetch(
    human(alpha, "/api/items", { title: "Private alpha" }),
  );
  expect(created.status).toBe(201);
  const { item_id: itemA } = await created.json<ItemOperationResult>();
  const connect = (id: string) =>
    fetch(human(id, "/ws", undefined, { Upgrade: "websocket" }));
  const socketA = await openSocket(await connect(alpha));
  expect(await socketA.next()).toMatchObject({
    type: "SNAPSHOT",
    seq: 1,
    items: [{ id: itemA }],
  });
  await evictDurableObject(workspace(alpha));
  socketA.socket.send(
    JSON.stringify({
      type: "SET_NOTE",
      requestId: "after-eviction",
      input: { item_id: itemA, note: "Reviewed" },
    }),
  );
  expect(await socketA.next()).toMatchObject({
    type: "ITEM_UPSERT",
    seq: 2,
    item: { id: itemA, note: "Reviewed" },
  });
  expect(await socketA.next()).toMatchObject({
    type: "ACK",
    requestId: "after-eviction",
  });
  expect(
    await (
      await fetch(human(alpha, `/api/items/${itemA}/events`))
    ).json<Event[]>(),
  ).toEqual([
    expect.objectContaining({ actor: user, kind: "note" }),
    expect.objectContaining({ actor: user, kind: "created" }),
  ]);

  const socketB = await openSocket(await connect(beta));
  expect(await socketB.next()).toMatchObject({
    type: "SNAPSHOT",
    seq: 1,
    items: [{ id: itemB }],
  });
  expect((await fetch(human(beta, `/api/items/${itemA}`))).status).toBe(404);
  expect((await fetch(human(alpha, `/api/items/${itemB}`))).status).toBe(404);

  expect(
    await toolResult(await fetch(rpc(tokenA, "get_canvas"))),
  ).toMatchObject({
    structuredContent: { items: [{ id: itemA }] },
  });
  expect(
    await toolResult(await fetch(rpc(tokenB, "get_canvas"))),
  ).toMatchObject({
    structuredContent: { items: [{ id: itemB }] },
  });
  expect((await fetch(report(tokenB, itemA))).status).toBe(404);
  expect((await fetch(report(tokenA, itemB))).status).toBe(404);
  expect((await fetch(report(tokenA, itemA))).status).toBe(200);

  host.getByName.mockClear();
  const unknownToken = `heed_unknown_${newTokenSecret()}`;
  expect((await fetch(rpc(unknownToken, "get_canvas"))).status).toBe(401);
  expect((await fetch(report(unknownToken, itemA))).status).toBe(401);
  expect((await fetch(human(suspended, "/api/me"))).status).toBe(403);
  expect((await connect(suspended)).status).toBe(403);
  const { token: suspendedToken } =
    await workspace(suspended).createToken("Suspended");
  const denied = await fetch(rpc(suspendedToken, "get_canvas"));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({
    error: { limit: "connect", message: "Workspace suspended." },
  });
  expect((await fetch(report(suspendedToken, itemA))).status).toBe(403);
  expect(host.getByName).not.toHaveBeenCalled();

  await waitOnExecutionContext(host.ctx);
  expect(host.record.mock.calls).toEqual([
    [alpha, { type: "agent.write", operation: "report_progress" }],
  ]);
});

it("refuses creation before the workspace operation and returns structured HTTP, socket and MCP errors", async () => {
  const host = setupHost();
  const { beta, fetch, human } = host;
  for (const [path, body, limit] of [
    ["/api/items", { title: "Denied" }, "item.create"],
    ["/api/projects", { name: "Denied" }, "project.create"],
    ["/api/tokens", { label: "Denied" }, "token.create"],
  ] as const) {
    const response = await fetch(human(beta, path, body));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: {
        code: "limit_exceeded",
        limit,
        message: expect.stringContaining("allowance"),
      },
    });
  }
  expect(host.getByName).not.toHaveBeenCalled();

  const socket = await openSocket(
    await fetch(human(beta, "/ws", undefined, { Upgrade: "websocket" })),
  );
  expect(await socket.next()).toMatchObject({ type: "SNAPSHOT", items: [] });
  for (const [type, input, limit] of [
    ["ADD_ITEM", { title: "Denied" }, "item.create"],
    ["CREATE_PROJECT", { name: "Denied" }, "project.create"],
    ["CREATE_TOKEN", { label: "Denied" }, "token.create"],
  ] as const) {
    socket.socket.send(JSON.stringify({ type, input, requestId: limit }));
    expect(await socket.next()).toMatchObject({
      type: "ERROR",
      requestId: limit,
      error: {
        code: "limit_exceeded",
        limit,
        message: expect.stringContaining("allowance"),
      },
    });
  }

  const { token } = await host.workspace(beta).createToken("Agent B");
  expect(
    await toolResult(await fetch(rpc(token, "add_item", { title: "Denied" }))),
  ).toEqual({
    isError: true,
    content: [
      {
        text: expect.stringContaining("Remove an existing resource."),
        type: "text",
      },
    ],
    structuredContent: {
      error: expect.stringContaining("item.create"),
      limit: "item.create",
    },
  });
  expect(await host.workspace(beta).getCanvas()).toMatchObject({ items: [] });
  host.keys.mockResolvedValueOnce({
    managed: true,
    configuration: { command: host.configuredProvider },
  });
  host.configuredProvider.next.mockResolvedValueOnce({
    text: "",
    calls: [
      {
        id: "denied-item",
        name: "add_item",
        input: { title: "Denied command item" },
      },
    ],
  });
  const command = await fetch(
    human(beta, "/api/command", { text: "Create an item" }),
  );
  expect(command.status).toBe(429);
  expect(await command.json()).toMatchObject({
    error: { limit: "item.create" },
  });
  const commandError =
    host.configuredProvider.next.mock.calls[1][0].history[0].replies[0];
  expect(commandError.isError).toBe(true);
  expect(JSON.parse(commandError.content)).toMatchObject({
    error: { limit: "item.create" },
  });
  expect(await host.workspace(beta).getCanvas()).toMatchObject({ items: [] });

  const { item_id } = await host
    .workspace(beta)
    .addItem({ kind: "human" }, { title: "Existing item" });
  expect(
    await toolResult(
      await fetch(
        rpc(token, "flag_handoff", { item_id, note: "Review", notify: true }),
      ),
    ),
  ).toMatchObject({
    isError: true,
    structuredContent: {
      limit: "push",
      error: expect.stringContaining("Flag the handoff without notifying"),
    },
  });
  expect(await host.workspace(beta).listProjects()).toHaveLength(1);
  expect(await host.workspace(beta).listTokens()).toHaveLength(1);
  await waitOnExecutionContext(host.ctx);
  expect(host.record.mock.calls.map(([, event]) => event.type)).toEqual([
    "command",
    "command",
  ]);
});

it("updates an existing external key at the creation limit through HTTP, MCP, sockets and commands", async () => {
  const check = vi.fn(hostLimits.check);
  const host = setupHost({ check });
  const { beta, fetch, human } = host;
  const workspace = host.workspace(beta);
  const external_key = "repo#branch";
  const newItem = { title: "Denied", external_key: "repo#new" };
  const { item_id } = await workspace.addItem(
    { kind: "human" },
    { title: "Original", external_key },
  );
  const { token } = await workspace.createToken("Agent B");

  const http = await fetch(
    human(beta, "/api/items", { title: "HTTP update", external_key }),
  );
  expect(http.status).toBe(201);
  expect(await http.json()).toMatchObject({
    item_id,
    items: [{ id: item_id, title: "HTTP update" }],
  });
  expect((await fetch(human(beta, "/api/items", newItem))).status).toBe(429);

  expect(
    await toolResult(
      await fetch(
        rpc(token, "add_item", { title: "MCP update", external_key }),
      ),
    ),
  ).toMatchObject({ structuredContent: { item_id } });
  expect(await workspace.getItem({ item_id })).toMatchObject({
    title: "MCP update",
  });
  expect(
    await toolResult(await fetch(rpc(token, "add_item", newItem))),
  ).toMatchObject({
    isError: true,
    structuredContent: { limit: "item.create" },
  });

  const socket = await openSocket(
    await fetch(human(beta, "/ws", undefined, { Upgrade: "websocket" })),
  );
  expect(await socket.next()).toMatchObject({ type: "SNAPSHOT" });
  socket.socket.send(
    JSON.stringify({
      type: "ADD_ITEM",
      input: { title: "Socket update", external_key },
      requestId: "update",
    }),
  );
  expect(await socket.next()).toMatchObject({
    type: "ITEM_UPSERT",
    item: { id: item_id, title: "Socket update" },
  });
  expect(await socket.next()).toMatchObject({
    type: "ACK",
    requestId: "update",
  });
  socket.socket.send(
    JSON.stringify({ type: "ADD_ITEM", input: newItem, requestId: "create" }),
  );
  expect(await socket.next()).toMatchObject({
    type: "ERROR",
    requestId: "create",
    error: { limit: "item.create" },
  });

  host.keys.mockResolvedValueOnce({
    managed: true,
    configuration: { command: host.configuredProvider },
  });
  host.configuredProvider.next.mockResolvedValueOnce({
    text: "",
    calls: [
      { id: "create", name: "add_item", input: newItem },
      {
        id: "update",
        name: "add_item",
        input: { title: "Command update", external_key },
      },
    ],
  });
  const command = await fetch(
    human(beta, "/api/command", {
      text: "Update the branch and add a new one",
    }),
  );
  expect(command.status).toBe(200);
  expect(await command.json()).toMatchObject({
    changes: [{ type: "item", id: item_id }],
    undoId: expect.any(String),
    refusal: { limit: "item.create" },
  });
  expect(await workspace.getCanvas()).toMatchObject({
    items: [{ id: item_id, title: "Command update" }],
  });
  expect(
    check.mock.calls.filter(([, action]) => action === "item.create"),
  ).toHaveLength(3);
  await waitOnExecutionContext(host.ctx);
});

it("updates a key inserted while the hosted creation check was pending", async () => {
  const check = vi.fn(hostLimits.check);
  const host = setupHost({ check });
  const { beta, fetch, human } = host;
  const workspace = host.workspace(beta);
  const external_key = "repo#branch";
  let insertedId: string | undefined;
  check.mockImplementation(async (workspaceId, action) => {
    if (action === "item.create") {
      const item = await workspace.addItem(
        { kind: "human" },
        { title: "Concurrent insert", external_key },
      );
      insertedId = item.item_id;
    }
    return hostLimits.check(workspaceId, action);
  });

  const response = await fetch(
    human(beta, "/api/items", { title: "Retry update", external_key }),
  );
  expect(response.status).toBe(201);
  expect(insertedId).toEqual(expect.any(String));
  expect(await response.json()).toMatchObject({ item_id: insertedId });
  expect(await workspace.getCanvas()).toMatchObject({
    items: [{ id: insertedId, title: "Retry update" }],
  });
});

function oneSecondWav() {
  const data = new ArrayBuffer(WAV_HEADER_BYTES + VOICE_SAMPLE_RATE * 2);
  const view = new DataView(data);
  view.setUint32(0, 0x52494646);
  view.setUint32(4, data.byteLength - 8, true);
  view.setUint32(8, 0x57415645);
  view.setUint32(12, 0x666d7420);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461);
  view.setUint32(40, data.byteLength - WAV_HEADER_BYTES, true);
  return data;
}

it("uses managed keys per workspace and meters model calls, transcription, agent writes and delivered pushes", async () => {
  const host = setupHost();
  const { alpha, beta, fetch, human, workspace, record } = host;
  expect(await (await fetch(human(alpha, "/api/me"))).json()).toMatchObject({
    user,
    workspaceId: alpha,
    role: "editor",
    managed: true,
    capabilities: { command: true, transcription: true },
  });
  expect(await (await fetch(human(beta, "/api/me"))).json()).toMatchObject({
    workspaceId: beta,
    managed: true,
    capabilities: { command: false, transcription: false },
  });

  let finishUsage!: () => void;
  const pendingUsage = new Promise<void>((resolve) => {
    finishUsage = resolve;
  });
  record.mockReturnValue(pendingUsage);
  try {
    const command = await fetch(
      human(alpha, "/api/command", { text: "Prepare a review" }),
    );
    expect(await command.json()).toMatchObject({ summary: "Ready to review." });
    const audio = await fetch(
      human(alpha, "/api/transcribe", oneSecondWav(), {
        "Content-Type": "audio/wav",
      }),
    );
    expect(await audio.json()).toEqual({ text: "Review the changes." });
    expect(
      (await fetch(human(beta, "/api/command", { text: "Prepare a review" })))
        .status,
    ).toBe(503);
  } finally {
    finishUsage();
  }

  const stub = workspace(alpha);
  const { token } = await stub.createToken("Reviewer agent");
  const result = await toolResult(
    await fetch(rpc(token, "add_item", { title: "Review the changes" })),
  );
  const { item_id } = result.structuredContent as { item_id: string };
  expect(item_id).toBeDefined();
  await stub.subscribePush({
    endpoint: "https://fcm.googleapis.com/fcm/send/app-metering-test",
    keys: {
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
  });
  const delivery = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 201 }));
  onTestFinished(() => delivery.mockRestore());
  expect(
    await toolResult(
      await fetch(
        rpc(token, "flag_handoff", { item_id, note: "Review", notify: true }),
      ),
    ),
  ).toMatchObject({
    structuredContent: { notification: "queued" },
  });
  await vi.waitFor(async () => {
    expect(await stub.pushEvents()).toEqual([
      { type: "push", count: 1 } satisfies UsageEvent,
    ]);
  });
  await waitOnExecutionContext(host.ctx);
  expect(record.mock.calls).toEqual([
    [
      alpha,
      {
        type: "command",
        model: "fixture-managed-model",
        inputTokens: 20,
        outputTokens: 4,
      },
    ],
    [alpha, { type: "transcribe", seconds: 1 }],
    [alpha, { type: "agent.write", operation: "add_item" }],
    [alpha, { type: "agent.write", operation: "flag_handoff" }],
  ]);
});

it("preserves the open request Durable Object lookup and RPC budgets", async () => {
  const secret = "lookup-count-test";
  const cookie = (await issueSession(user.email, secret)).split(";")[0];
  const workspace = env.WORKSPACE.getByName("default");
  const { token } = await workspace.createToken("Lookup test");
  const { item_id } = await workspace.addItem(
    { kind: "human" },
    { title: "Lookup check" },
  );
  const operations: string[] = [];
  const stub = new Proxy(workspace, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        operations.push(String(key));
        return Reflect.apply(value, target, args);
      };
    },
  });
  const getByName = vi.fn(() => stub);
  const bindings = {
    ...env,
    SESSION_SECRET: secret,
    ADMIN_SECRET: secret,
    WORKSPACE: { getByName } as unknown as Env["WORKSPACE"],
    TOKEN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AI: {
      run: async () => ({ response: "Ready.", text: "Ready." }),
    } as unknown as Ai,
    WORKERS_AI_COMMAND_MODEL: "lookup-test-model",
  };
  const signed = (
    path: string,
    body?: object | ArrayBuffer,
    headers?: Record<string, string>,
  ) => request(path, new Headers({ Cookie: cookie, ...headers }), body);

  for (const [req, status, expected] of [
    [request("/api/health"), 200, []],
    [signed("/api/me"), 200, []],
    [signed("/api/projects"), 200, ["listProjects"]],
    [signed("/api/items", { title: "New task" }), 201, ["addItem"]],
    [signed("/api/projects", { name: "Lookup check" }), 201, ["createProject"]],
    [signed("/api/tokens", { label: "New token" }), 201, ["createToken"]],
    [
      signed(
        "/api/admin/tokens",
        { label: "Bootstrap token" },
        { Authorization: `Bearer ${secret}` },
      ),
      201,
      ["createToken"],
    ],
    [
      signed("/api/command", { text: "Check project" }),
      200,
      ["reserveCommandQuota", "getCommandContext"],
    ],
    [
      signed("/api/transcribe", oneSecondWav(), {
        "Content-Type": "audio/wav",
      }),
      200,
      ["reserveCommandQuota"],
    ],
    [signed("/ws", undefined, { Upgrade: "websocket" }), 101, ["fetch"]],
    [rpc(token, "get_canvas"), 200, ["verifyToken", "getCanvas"]],
    [report(token, item_id), 200, ["verifyToken", "reportProgress"]],
    [report(`heed_other_${newTokenSecret()}`, item_id), 401, []],
  ] as const) {
    operations.length = 0;
    getByName.mockClear();
    const response = await fetchOpen(req, bindings);
    expect(response.status, req.url).toBe(status);
    expect(operations, req.url).toEqual(expected);
    expect(getByName, req.url).toHaveBeenCalledTimes(expected.length ? 1 : 0);
    if (response.webSocket) {
      response.webSocket.accept();
      response.webSocket.close(1000);
    }
  }
});
