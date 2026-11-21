import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { fetchOpen } from "./worker-test-helpers";
import { getWorkspaceStub } from "./workspace";

const workspace = getWorkspaceStub(env, "default");
const human = { kind: "human" } as const;
const bindings = {
  ...env,
  TOKEN_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

function postMcp(
  token: string,
  method: string,
  params: object = {},
  headers: Record<string, string> = {},
) {
  return fetchOpen(
    new Request("https://heed.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    bindings,
  );
}

async function rpc<T>(...request: Parameters<typeof postMcp>) {
  const response = await postMcp(...request);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.has("Mcp-Session-Id")).toBe(false);
  const body = await response.json<{ result: T; error?: object }>();
  expect(body.error).toBeUndefined();
  return body.result;
}

function call(token: string, name: string, args: object = {}) {
  return rpc<{
    structuredContent: { item_id?: string; guidance_updated_at: string | null };
    content: { type: string; text: string }[];
    isError?: boolean;
  }>(token, "tools/call", { name, arguments: args });
}

it("initializes with current guidance and lists exactly the eight behavioural tools", async () => {
  const { token } = await workspace.createToken("Reader");
  const initialize = () =>
    rpc<{ instructions: string; protocolVersion: string }>(
      token,
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    );

  await workspace.setGuidance(human, "Schedule billing for today.");
  const initial = await initialize();
  expect(initial.protocolVersion).toBe("2025-11-25");
  expect(initial.instructions).toContain("mark it active when you start");
  expect(initial.instructions).toMatch(/Schedule billing for today\.$/);
  await workspace.setGuidance(human, "Park billing in the backlog.");
  expect((await initialize()).instructions).toMatch(
    /Park billing in the backlog\.$/,
  );

  const { tools } = await rpc<{
    tools: { name: string; description: string; inputSchema: object }[];
  }>(token, "tools/list");
  expect(tools.map(({ name }) => name).sort()).toEqual([
    "add_item",
    "flag_handoff",
    "get_canvas",
    "reopen_item",
    "report_progress",
    "set_dependency",
    "set_guidance",
    "update_item",
  ]);
  for (const tool of tools) {
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  }
  expect(tools.find(({ name }) => name === "add_item")).toMatchObject({
    description:
      'Add work to the user\'s view. Use it when you start something that has no item yet, when you split a task into parts (pass parent_id), or when you discover follow-up work that should not be forgotten (leave it in the backlog). Call get_canvas first to avoid duplicates, and pass external_key (PR URL or repo#branch) so retries update the same item. When the work has a clear finish line, pass acceptance: up to eight short, checkable "done when" statements.',
    inputSchema: {
      properties: {
        acceptance: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  });
  expect(tools.find(({ name }) => name === "report_progress")).toMatchObject({
    description:
      'Tell the user what you are working on. Call this (1) when you start work, with status "active"; (2) after each meaningful step, or at least every 10 minutes during long work, with a one-line note; (3) when you finish, with status "done", the PR or issue link as ref_url, and as evidence the actual output that shows the item\'s acceptance criteria are met (test summary, CI result), copied rather than paraphrased; (4) when you cannot continue, with status "blocked" and the reason. If no item exists for the work yet, call add_item first. Always pass a stable agent_name.',
    inputSchema: {
      properties: { evidence: { type: "string", maxLength: 4_000 } },
    },
  });
});

it("serves discovery and tool calls over the 2026 per-request protocol in JSON", async () => {
  const { token } = await workspace.createToken("MCP client");
  await workspace.setGuidance(human, "Escalate production outages.");
  const version = "2026-07-28";
  function send<T>(method: string, params: object = {}, toolName?: string) {
    return rpc<T>(
      token,
      method,
      {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: version,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
      {
        Accept: "application/json",
        "MCP-Protocol-Version": version,
        "Mcp-Method": method,
        ...(toolName && { "Mcp-Name": toolName }),
      },
    );
  }

  expect(await send("server/discover")).toMatchObject({
    instructions: expect.stringContaining("Escalate production outages."),
    supportedVersions: [version],
  });
  expect(
    await send("tools/call", { name: "get_canvas" }, "get_canvas"),
  ).toMatchObject({
    structuredContent: { guidance: "Escalate production outages.", items: [] },
  });
});

it("executes each tool through the authenticated workspace RPC", async () => {
  const { token } = await workspace.createToken("Builder", "steer");
  const saved = (
    await call(token, "set_guidance", { text: "Prioritize billing." })
  ).structuredContent;
  expect(saved).toMatchObject({
    guidance: "Prioritize billing.",
    guidance_updated_at: expect.any(String),
  });

  async function run(name: string, args: object = {}) {
    const result = await call(token, name, args);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.guidance_updated_at).toBe(
      saved.guidance_updated_at,
    );
    expect(JSON.parse(result.content[0].text)).toEqual(
      result.structuredContent,
    );
    return result.structuredContent;
  }

  const { item_id } = await run("add_item", {
    title: "Initial",
    external_key: "billing",
    acceptance: ["Invoice can be paid"],
  });
  const acceptance = ["Invoice can be paid", "Payment receipt is sent"];
  await run("update_item", {
    item_id,
    title: "Billing integration",
    acceptance,
  });
  expect(
    await run("report_progress", {
      external_key: "billing",
      status: "active",
      agent_name: "Build agent",
      evidence: "Build started",
    }),
  ).toMatchObject({ ignored_fields: ["evidence"] });
  expect(
    await run("get_canvas", {
      project: "Inbox",
      query: "billing",
      parent_id: null,
    }),
  ).toMatchObject({
    guidance: "Prioritize billing.",
    items: [
      {
        id: item_id,
        title: "Billing integration",
        status: "active",
        agent_name: "Build agent",
        band: "today",
        acceptance,
      },
    ],
  });

  const blocker = await run("add_item", { title: "Approval" });
  expect(
    await run("set_dependency", {
      item_id,
      blocked_by_id: blocker.item_id,
      action: "add",
    }),
  ).toMatchObject({
    dependency: { item_id, blocked_by_id: blocker.item_id, action: "add" },
  });
  await run("flag_handoff", {
    item_id,
    note: "Please approve the billing changes",
  });
  const evidence = "Payment tests: 8 passed";
  await run("report_progress", { item_id, status: "done", evidence });
  expect(await workspace.getItemEvents({ item_id: item_id! })).toContainEqual(
    expect.objectContaining({
      kind: "status",
      detail: JSON.stringify({ old: "active", new: "done", evidence }),
    }),
  );
  expect(await run("get_canvas", { query: "billing" })).toMatchObject({
    items: [],
  });
  expect(
    await run("get_canvas", { query: "billing", include_done: true }),
  ).toMatchObject({
    items: [{ id: item_id, status: "done" }],
  });
  await run("reopen_item", {
    external_key: "billing",
    reason: "Follow-up requested",
  });
  expect(await run("get_canvas", { query: "billing" })).toMatchObject({
    items: [{ id: item_id, status: "queued" }],
  });
});

it("keeps canvas responses bounded when criteria make a page too large", async () => {
  const { token } = await workspace.createToken("Reader");
  const acceptance = Array<string>(8).fill("🙂".repeat(200));
  for (let index = 0; index < 21; index++) {
    await workspace.addItem(human, { title: `Release ${index}`, acceptance });
  }
  expect(await call(token, "get_canvas")).toMatchObject({
    isError: true,
    structuredContent: {
      error:
        "Canvas result is too large. Narrow the filters or lower the limit.",
    },
  });
  expect(await call(token, "get_canvas", { limit: 1 })).toMatchObject({
    structuredContent: { items: [{ acceptance }] },
  });
});

it("reports validation and scope errors with guidance and acknowledges ignored fields", async () => {
  const { token } = await workspace.createToken("Reporter", "report");
  const guidance = await workspace.setGuidance(human, "Review changes first.");
  const { item_id } = await workspace.addItem(human, {
    title: "Locked item",
    priority: 9,
  });
  for (const [name, args, error] of [
    [
      "set_guidance",
      { text: "Override" },
      "Report scope cannot change guidance",
    ],
    [
      "update_item",
      { item_id, hidden: true },
      "Report scope cannot change hidden",
    ],
    ["report_progress", {}, "Provide exactly one of item_id or external_key"],
    ["report_progress", { item_id: "missing" }, "Call get_canvas"],
  ] as const) {
    const result = await call(token, name, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      guidance_updated_at: guidance.guidance_updated_at,
      error: expect.stringContaining(error),
    });
  }
  expect(await workspace.getGuidance()).toEqual(guidance);
  const result = await call(token, "update_item", {
    item_id,
    title: "Renamed",
    priority: 1,
  });
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({
    item_id,
    ignored_fields: ["priority"],
  });
});

it("rejects authenticated GET and DELETE for the stateless endpoint", async () => {
  const { token } = await workspace.createToken("Reader");
  for (const method of ["GET", "DELETE"]) {
    const response = await fetchOpen(
      new Request("https://heed.test/mcp", {
        method,
        headers: { Authorization: `Bearer ${token}` },
      }),
      bindings,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  }
});

it("rejects a mismatched Origin and accepts the endpoint's own Origin", async () => {
  const { token } = await workspace.createToken("Reader");
  const denied = await postMcp(
    token,
    "tools/list",
    {},
    {
      Origin: "https://other.test",
    },
  );
  expect(denied.status).toBe(403);
  const allowed = await postMcp(
    token,
    "tools/list",
    {},
    {
      Origin: "https://heed.test",
    },
  );
  expect(allowed.status).toBe(200);
});

it("reports a flagged handoff without delivery when the token has exhausted its push quota", async () => {
  const { token, id } = await workspace.createToken("Builder");
  const endpoint = "https://fcm.googleapis.com/fcm/send/mcp-quota-test";
  try {
    await workspace.subscribePush({
      endpoint,
      keys: {
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
    });
    await runInDurableObject(workspace, (_, { storage: { sql } }) => {
      sql.exec(
        "INSERT INTO push_rate_limits (token_id, attempts) VALUES (?, ?)",
        id,
        JSON.stringify(Array.from({ length: 6 }, () => Date.now())),
      );
    });
    const { item_id } = await workspace.addItem(human, {
      title: "Quota check",
    });
    const response = await call(token, "flag_handoff", {
      item_id,
      note: "Review this",
      notify: true,
    });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      item_id,
      notification: "rate_limited",
      message: expect.stringContaining("No push sent"),
    });
    expect(await workspace.getItem({ item_id })).toMatchObject({
      handoff: 1,
      handoff_note: "Review this",
    });
  } finally {
    await workspace.unsubscribePush({ endpoint });
  }
});
