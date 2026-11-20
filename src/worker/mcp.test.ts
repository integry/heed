import { env } from "cloudflare:workers";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import worker from "./index";
import { getWorkspaceStub } from "./workspace";

const workspace = getWorkspaceStub(env);
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
  return worker.fetch(
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
  expect(
    tools.find(({ name }) => name === "report_progress")?.description,
  ).toContain("at least every 10 minutes");
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
  });
  await run("update_item", { item_id, title: "Billing integration" });
  await run("report_progress", {
    external_key: "billing",
    status: "active",
    agent_name: "Build agent",
  });
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
  await run("report_progress", { item_id, status: "done" });
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

it("rejects GET and DELETE for the stateless endpoint", async () => {
  for (const method of ["GET", "DELETE"]) {
    const response = await worker.fetch(
      new Request("https://heed.test/mcp", { method }),
      env,
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
