import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { VOICE_BYTES_LIMIT, VOICE_SAMPLE_RATE } from "../shared/command";
import type { CommandResult } from "../shared/command";
import type { SocketMessage } from "../shared/workspace-socket";
import { runCommand } from "./command-api";
import type { CommandTurn } from "./command-provider";
import worker from "./index";
import { issueSession } from "./session";
import { getWorkspaceStub } from "./workspace";

const origin = "https://heed.test";
const secret = "command-test-session-secret";
const human = { kind: "human" } as const;
let workspace: ReturnType<typeof getWorkspaceStub>;
let cookie: string;
const getByName = vi.fn(() => workspace);
const limit = vi.fn<Env["TOKEN_RATE_LIMITER"]["limit"]>();
const run = vi.fn();
const bindings = {
  ...env,
  AI: { run } as unknown as Ai,
  SESSION_SECRET: secret,
  WORKSPACE: { getByName } as unknown as Env["WORKSPACE"],
  TOKEN_RATE_LIMITER: { limit },
  WORKERS_AI_COMMAND_MODEL: "fake-tool-model",
};

beforeEach(async () => {
  workspace = getWorkspaceStub(env, crypto.randomUUID());
  cookie = (await issueSession("member@example.test", secret)).split(";")[0];
  getByName.mockClear();
  limit.mockReset().mockResolvedValue({ success: true });
  run.mockReset();
});

function post(
  path: string,
  body: BodyInit,
  options = bindings,
  contentType = "application/json",
) {
  return worker.fetch(
    new Request(origin + path, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": contentType },
      body,
    }),
    options,
  );
}

function command(text: string, options = bindings) {
  return post("/api/command", JSON.stringify({ text }), options);
}

function turn(text: string, ...calls: CommandTurn["calls"]): CommandTurn {
  return { text, calls };
}

function call(name: string, input: object, id = name) {
  return { id, name, input };
}

it("updates guidance through a single command and returns its actual write", async () => {
  const next = vi
    .fn()
    .mockResolvedValueOnce(
      turn("", call("set_guidance", { text: "Only notify me about billing." })),
    )
    .mockResolvedValueOnce(turn("Updated your standing guidance."));

  const result = await runCommand(
    workspace,
    { next },
    "From now on, only notify me about billing",
  );
  expect(result).toEqual({
    summary: "Updated your standing guidance.",
    changes: [{ type: "guidance" }],
    undoId: expect.any(String),
  });
  expect((await workspace.getGuidance()).guidance).toBe(
    "Only notify me about billing.",
  );
  expect(next.mock.calls[1][0].history[0].replies[0]).toMatchObject({
    call: { name: "set_guidance" },
    isError: false,
  });
});

it("looks up items, applies multiple steer operations, and undoes them over the WebSocket", async () => {
  const project = await workspace.createProject({ name: "Clients" });
  const { item_id } = await workspace.addItem(human, {
    title: "API rate limiter",
  });
  await workspace.setTimezone("Pacific/Auckland");
  await workspace.setGuidance(human, "Prioritize production incidents.");
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const response = await worker.fetch(
    new Request(origin + "/ws", {
      headers: { Cookie: cookie, Origin: origin, Upgrade: "websocket" },
    }),
    bindings,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const reader = new ReadableStream<SocketMessage>({
    start(controller) {
      socket.addEventListener("message", (event) =>
        controller.enqueue(JSON.parse(event.data as string)),
      );
    },
  }).getReader();
  socket.accept();
  try {
    expect((await reader.read()).value?.type).toBe("SNAPSHOT");
    run
      .mockResolvedValueOnce({
        tool_calls: [
          { name: "get_canvas", arguments: { query: "rate limiter" } },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "move",
                  function: {
                    name: "update_item",
                    arguments: JSON.stringify({ item_id, scheduled_on: date }),
                  },
                },
                {
                  id: "hide",
                  function: {
                    name: "toggle_project",
                    arguments: JSON.stringify({
                      project_id: project.id,
                      hidden: true,
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        response: "Moved API rate limiter to Today and hid Clients.",
      });

    const result = await command(
      "Move the rate limiter into today and hide Clients.",
    );
    expect(result.status).toBe(200);
    const { summary, changes, undoId } = await result.json<CommandResult>();
    expect(summary).toContain("hid Clients");
    expect(changes).toEqual([
      { type: "item", id: item_id },
      { type: "project", id: project.id },
    ]);
    expect(undoId).toEqual(expect.any(String));
    const initial = run.mock.calls[0][1];
    expect(initial.messages[0].content).toContain(date);
    expect(initial.messages[0].content).toContain("Pacific/Auckland");
    expect(initial.messages[0].content).toContain(
      "Prioritize production incidents.",
    );
    expect(initial.messages[0].content).toContain("Clients");
    expect(
      initial.tools.some(({ function: tool }: { function: { name: string } }) =>
        tool.name.includes("delete"),
      ),
    ).toBe(false);
    expect(run.mock.calls[1][1].messages.at(-1)).toMatchObject({
      role: "tool",
      name: "get_canvas",
      content: expect.stringContaining(item_id),
    });

    expect((await reader.read()).value).toMatchObject({
      type: "ITEM_UPSERT",
      item: {
        id: item_id,
        scheduled_on: date,
        locked_fields: '["scheduled_on"]',
      },
    });
    expect((await reader.read()).value).toMatchObject({
      type: "PROJECT_UPSERT",
      project: { id: project.id, hidden: 1 },
    });
    socket.send(
      JSON.stringify({
        type: "UNDO_COMMAND",
        input: { id: undoId },
        requestId: "undo",
      }),
    );
    expect((await reader.read()).value).toMatchObject({
      type: "PROJECT_UPSERT",
      project: { id: project.id, hidden: 0 },
    });
    expect((await reader.read()).value).toMatchObject({
      type: "ITEM_UPSERT",
      item: { id: item_id, scheduled_on: null, locked_fields: "[]" },
    });
    expect((await reader.read()).value).toMatchObject({
      type: "ACK",
      requestId: "undo",
    });
    socket.send(
      JSON.stringify({
        type: "UNDO_COMMAND",
        input: { id: undoId },
        requestId: "repeat",
      }),
    );
    expect((await reader.read()).value).toMatchObject({
      type: "ERROR",
      requestId: "repeat",
    });
    const conflict = await runCommand(
      workspace,
      {
        next: vi
          .fn()
          .mockResolvedValueOnce(
            turn(
              "",
              call("update_item", { item_id, priority: 8 }),
              call("toggle_project", { project_id: project.id, hidden: true }),
            ),
          )
          .mockResolvedValueOnce(
            turn("Updated the rate limiter and hid Clients."),
          ),
      },
      "Raise the priority of the API rate limiter and hide Clients.",
    );
    await reader.read(); // Item change
    await reader.read(); // Project hidden
    await workspace.updateItem(human, { item_id, priority: 9 });
    await reader.read();
    socket.send(
      JSON.stringify({
        type: "UNDO_COMMAND",
        input: { id: conflict.undoId },
        requestId: "conflict",
      }),
    );
    expect((await reader.read()).value).toMatchObject({
      type: "ERROR",
      requestId: "conflict",
      error: { code: "conflict" },
    });
    expect(
      (await workspace.listProjects()).find(({ id }) => id === project.id)
        ?.hidden,
    ).toBe(1);
  } finally {
    socket.close(1000);
  }
});

it("returns a one-line clarification after finding ambiguous matches", async () => {
  const clients = await workspace.createProject({ name: "Clients" });
  await workspace.addItem(human, { title: "Rate limiter" });
  await workspace.addItem(human, {
    title: "Rate limiter",
    project: clients.id,
  });
  const next = vi
    .fn()
    .mockResolvedValueOnce(
      turn("", call("get_canvas", { query: "Rate limiter" })),
    )
    .mockImplementationOnce(async ({ history }) => {
      expect(JSON.parse(history[0].replies[0].content).items).toHaveLength(2);
      return turn(
        "Which rate limiter should I move, the one in Inbox or Clients?",
      );
    });
  expect(
    await runCommand(workspace, { next }, "Move the rate limiter into today"),
  ).toEqual({
    summary: "Which rate limiter should I move, the one in Inbox or Clients?",
    changes: [],
  });
});

it("limits model steps and tool calls, and rejects unknown tools", async () => {
  const next = vi
    .fn()
    .mockResolvedValue(turn("", call("delete_item", { item_id: "anything" })));
  const result = await runCommand(workspace, { next }, "Delete everything");
  expect(next).toHaveBeenCalledTimes(6);
  expect(next.mock.calls[1][0].history[0].replies[0]).toMatchObject({
    isError: true,
  });
  expect(result).toMatchObject({
    summary: expect.stringContaining("step limit"),
    changes: [],
  });
  const batch = vi
    .fn()
    .mockResolvedValue(
      turn(
        "",
        ...Array.from({ length: 7 }, (_, i) =>
          call("set_guidance", { text: "Never written" }, String(i)),
        ),
      ),
    );
  expect(
    (await runCommand(workspace, { next: batch }, "Change guidance")).changes,
  ).toEqual([]);
  expect((await workspace.getGuidance()).guidance).toBe("");
});

it("reports the unconfigured state before rate limiting or looking up the workspace", async () => {
  const unset = { ...bindings, WORKERS_AI_COMMAND_MODEL: "" };
  const response = await command("Move an item", unset);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "not_configured" },
  });
  const me = await worker.fetch(
    new Request(origin + "/api/me", { headers: { Cookie: cookie } }),
    unset,
  );
  expect(await me.json()).toMatchObject({
    capabilities: { command: false, transcription: false },
  });
  expect(limit).not.toHaveBeenCalled();
  expect(getByName).not.toHaveBeenCalled();
});

it("uses a stable per-session rate key across refreshed cookies and enforces the workspace daily cap", async () => {
  const vars = {
    ...bindings,
    COMMAND_RATE_LIMIT_PER_MINUTE: "2",
    COMMAND_DAILY_LIMIT: "1",
  };
  run.mockResolvedValue({ response: "No changes made." });
  const first = await command("Check the canvas", vars);
  expect(first.status).toBe(200);
  cookie = first.headers.get("Set-Cookie")!.split(";")[0];

  const daily = await command("Check the canvas again", vars);
  expect(daily.status).toBe(429);
  expect(await daily.json()).toMatchObject({
    error: { message: expect.stringContaining("daily limit") },
  });
  expect(limit.mock.calls[0]).toEqual(limit.mock.calls[1]);
  expect(limit.mock.calls[1][0]).toMatchObject({
    key: expect.stringMatching(/^command:/),
    delta: 500_000,
  });

  getByName.mockClear();
  limit.mockResolvedValueOnce({ success: false });
  const limited = await command("Check again", vars);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("60");
  expect(getByName).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledTimes(1);
});

it("meters Whisper separately and verifies the audio format and byte limit before inference", async () => {
  const buffer = new ArrayBuffer(46);
  const view = new DataView(buffer);
  view.setUint32(0, 0x52494646);
  view.setUint32(4, 38, true);
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
  view.setUint32(40, 2, true);
  const transcribe = (body: ArrayBuffer) =>
    post("/api/transcribe", body, bindings, "audio/wav");
  expect(
    (await transcribe(new ArrayBuffer(VOICE_BYTES_LIMIT + 2))).status,
  ).toBe(413);
  expect((await transcribe(new ArrayBuffer(46))).status).toBe(400);
  expect(run).not.toHaveBeenCalled();
  expect(limit).not.toHaveBeenCalled();

  run.mockResolvedValue({ text: " Update my guidance. " });
  const response = await transcribe(buffer);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "Update my guidance." });
  expect(run).toHaveBeenCalledWith(
    "@cf/openai/whisper-large-v3-turbo",
    {
      audio: expect.stringMatching(/^UklGR/),
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(limit.mock.calls[0][0].key).toMatch(/^transcribe:/);
});

it("sends Anthropic tool results with their original tool-use IDs", async () => {
  const fetchMessage = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "set_guidance",
            input: { text: "Keep billing visible." },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "Updated your guidance." }],
      }),
    );
  try {
    const response = await command("Keep billing visible from now on", {
      ...bindings,
      ANTHROPIC_API_KEY: "fixture-key",
      ANTHROPIC_COMMAND_MODEL: "fixture-model",
    } as typeof bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      changes: [{ type: "guidance" }],
    });
    expect(run).not.toHaveBeenCalled();
    expect(fetchMessage.mock.calls[0][0]).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    const initial = JSON.parse(String(fetchMessage.mock.calls[0][1]?.body));
    expect(initial.model).toBe("fixture-model");
    expect(initial.tools).toContainEqual(
      expect.objectContaining({
        name: "set_guidance",
        input_schema: expect.objectContaining({ type: "object" }),
      }),
    );
    const followup = JSON.parse(String(fetchMessage.mock.calls[1][1]?.body));
    expect(followup.messages.at(-1).content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      is_error: false,
    });
    expect((await workspace.getGuidance()).guidance).toBe(
      "Keep billing visible.",
    );
  } finally {
    fetchMessage.mockRestore();
  }
});
