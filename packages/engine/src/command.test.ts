import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { VOICE_BYTES_LIMIT, VOICE_SAMPLE_RATE } from "@heedwork/core";
import type { CommandResult } from "@heedwork/core";
import type { SocketMessage } from "@heedwork/core";
import { runCommand } from "./command-api";
import type { CommandTurn } from "./command-provider";
import { fetchOpen } from "./worker-test-helpers";
import { issueSession } from "./auth";
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
  return fetchOpen(
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
    needsClarification: false,
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

  const response = await fetchOpen(
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
                    name: "update_project",
                    arguments: JSON.stringify({
                      project: project.id,
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
    // The text line offers every workspace operation, deletion included.
    expect(
      initial.tools.map(
        ({ function: tool }: { function: { name: string } }) => tool.name,
      ),
    ).toEqual(
      expect.arrayContaining(["create_project", "delete_item", "get_item"]),
    );
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
              call("update_project", { project: project.id, hidden: true }),
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

it("copies the complete reference URL from a canvas search to another item", async () => {
  const ref_url = `https://docs.example.test/document?share=${"a".repeat(280)}&view=review#notes`;
  await workspace.addItem(human, { title: "Source document", ref_url });
  const { item_id } = await workspace.addItem(human, {
    title: "Destination document",
  });
  run
    .mockResolvedValueOnce({
      tool_calls: [{ name: "get_canvas", arguments: { query: "document" } }],
    })
    .mockImplementationOnce(async (_model, { messages }) => {
      const { items } = JSON.parse(messages.at(-1).content);
      const source = items.find(
        ({ title }: { title: string }) => title === "Source document",
      );
      const destination = items.find(
        ({ title }: { title: string }) => title === "Destination document",
      );
      return {
        tool_calls: [
          {
            name: "update_item",
            arguments: { item_id: destination.id, ref_url: source.ref_url },
          },
        ],
      };
    })
    .mockResolvedValueOnce({ response: "Copied the source reference link." });

  const response = await command(
    "Copy the source document's reference link to the destination document.",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    changes: [{ type: "item", id: item_id }],
  });
  expect(
    (await workspace.getCanvas({ query: "Destination document" })).items,
  ).toMatchObject([{ ref_url }]);
});

it("sets acceptance criteria and reports completion evidence through command tools", async () => {
  const created = await workspace.executeCommandTool("add_item", {
    title: "Deploy",
    acceptance: ["Verify rollout"],
  });
  expect(created.isError).toBe(false);
  const { item_id } = JSON.parse(created.content);
  const acceptance = ["Verify the smoke tests"];
  const updated = await workspace.executeCommandTool("update_item", {
    item_id,
    acceptance,
  });
  expect(updated.isError).toBe(false);
  expect(await workspace.getItem({ item_id })).toMatchObject({
    acceptance: JSON.stringify(acceptance),
    locked_fields: '["acceptance"]',
  });
  const lookup = await workspace.executeCommandTool("get_canvas", {
    query: "Deploy",
  });
  expect(JSON.parse(lookup.content)).toMatchObject({
    items: [{ id: item_id, acceptance }],
  });
  const ignored = await workspace.executeCommandTool("report_progress", {
    item_id,
    evidence: "Tests running",
  });
  expect(JSON.parse(ignored.content)).toMatchObject({
    ignored_fields: ["evidence"],
  });
  const evidence = "Smoke tests: 6 passed";
  const completed = await workspace.executeCommandTool("report_progress", {
    item_id,
    status: "done",
    evidence,
  });
  expect(completed.isError).toBe(false);
  expect(await workspace.getItemEvents({ item_id })).toContainEqual(
    expect.objectContaining({
      kind: "status",
      detail: JSON.stringify({ old: "queued", new: "done", evidence }),
    }),
  );
});

it("returns a tool error without partial links when the canvas result exceeds its size limit", async () => {
  const firstUrl = `https://docs.example.test/first?share=${"a".repeat(10_000)}&view=review`;
  const secondUrl = `https://docs.example.test/second?share=${"b".repeat(10_000)}&view=review`;
  await workspace.addItem(human, {
    title: "First document",
    ref_url: firstUrl,
  });
  await workspace.addItem(human, {
    title: "Second document",
    ref_url: secondUrl,
  });

  const broad = await workspace.executeCommandTool("get_canvas", {
    query: "document",
  });
  expect(broad).toMatchObject({ isError: true, effects: [] });
  expect(JSON.parse(broad.content)).toEqual({
    error: "Result too large. Narrow your search.",
  });

  const narrow = await workspace.executeCommandTool("get_canvas", {
    query: "First document",
  });
  expect(narrow).toMatchObject({ isError: false, effects: [] });
  expect(JSON.parse(narrow.content).items).toMatchObject([
    { ref_url: firstUrl },
  ]);
});

const reviewQuestion =
  "Which review do you mean: Billing or Invoices? Reply with the project name.";

it.each([
  ["native", reviewQuestion],
  [
    "chat",
    "Which review should I move, given the project names ".padEnd(500, "x") +
      "?",
  ],
] as const)(
  "returns explicit clarification from Workers AI's %s response",
  async (format, question) => {
    const billing = await workspace.createProject({ name: "Billing" });
    const invoices = await workspace.createProject({ name: "Invoices" });
    await workspace.addItem(human, { title: "Review", project: billing.id });
    await workspace.addItem(human, { title: "Review", project: invoices.id });
    run
      .mockResolvedValueOnce({
        tool_calls: [{ name: "get_canvas", arguments: { query: "Review" } }],
      })
      .mockImplementationOnce(async (_model, { messages }) => {
        expect(JSON.parse(messages.at(-1).content).items).toHaveLength(2);
        if (format === "native") {
          return {
            tool_calls: [
              { name: "request_clarification", arguments: { question } },
            ],
          };
        }
        return {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "request_clarification",
                      arguments: JSON.stringify({ question }),
                    },
                  },
                ],
              },
            },
          ],
        };
      });

    const response = await command("Move the review into Today");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: question.slice(0, 500),
      needsClarification: true,
      changes: [],
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1].messages[0].content).toContain(
      "call request_clarification",
    );
    expect(run.mock.calls[0][1].tools).toContainEqual({
      type: "function",
      function: expect.objectContaining({
        name: "request_clarification",
        parameters: expect.objectContaining({ required: ["question"] }),
      }),
    });
  },
);

it.each([false, true])(
  "skips writes batched with clarification and checks earlier writes (prior write: %s)",
  async (priorWrite) => {
    const next = vi.fn();
    if (priorWrite) {
      next.mockResolvedValueOnce(
        turn("", call("set_guidance", { text: "Already written." })),
      );
    }
    next.mockResolvedValueOnce(
      turn(
        "",
        call("set_guidance", { text: "Never written." }),
        call("request_clarification", { question: reviewQuestion }),
      ),
    );

    const result = await runCommand(workspace, { next }, "Move the review");
    if (priorWrite) {
      expect(result).toMatchObject({
        needsClarification: false,
        changes: [{ type: "guidance" }],
        undoId: expect.any(String),
      });
    } else {
      expect(result).toEqual({
        summary: reviewQuestion,
        needsClarification: true,
        changes: [],
      });
    }
    expect((await workspace.getGuidance()).guidance).toBe(
      priorWrite ? "Already written." : "",
    );
  },
);

it("returns explicit clarification from an Anthropic tool call", async () => {
  const fetchMessage = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "request_clarification",
          input: { question: reviewQuestion },
        },
      ],
    }),
  );
  try {
    const response = await command("Move the review into Today", {
      ...bindings,
      ANTHROPIC_API_KEY: "fixture-key",
      ANTHROPIC_COMMAND_MODEL: "fixture-model",
    } as typeof bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: reviewQuestion,
      needsClarification: true,
      changes: [],
    });
    expect(fetchMessage).toHaveBeenCalledTimes(1);
    const initial = JSON.parse(String(fetchMessage.mock.calls[0][1]?.body));
    expect(initial.tools).toContainEqual(
      expect.objectContaining({
        name: "request_clarification",
        input_schema: expect.objectContaining({ required: ["question"] }),
      }),
    );
  } finally {
    fetchMessage.mockRestore();
  }
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
  const me = await fetchOpen(
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

it("sends Anthropic-format commands to a configured compatible endpoint", async () => {
  const fetchMessage = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      content: [{ type: "text", text: "Nothing needs you." }],
    }),
  );
  try {
    const response = await command("What needs me?", {
      ...bindings,
      ANTHROPIC_API_KEY: "fixture-key",
      ANTHROPIC_COMMAND_MODEL: "fixture-model",
      ANTHROPIC_MESSAGES_URL: "https://gateway.example/v1/messages",
    } as typeof bindings);
    expect(response.status).toBe(200);
    expect(fetchMessage.mock.calls[0][0]).toBe(
      "https://gateway.example/v1/messages",
    );
  } finally {
    fetchMessage.mockRestore();
  }
});

it("returns the user's handoff reply from a command and records their identity", async () => {
  const { item_id } = await workspace.addItem(human, {
    title: "Rollout",
    status: "blocked",
  });
  await workspace.flagHandoff(human, { item_id, note: "Which environment?" });
  run
    .mockResolvedValueOnce({
      tool_calls: [
        { name: "answer_handoff", arguments: { item_id, text: "Use staging" } },
      ],
    })
    .mockResolvedValueOnce({ response: "Sent your reply." });
  const response = await command("Tell the rollout agent to use staging.");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    changes: [{ type: "item", id: item_id }],
  });
  expect(await workspace.getItem({ item_id })).toMatchObject({
    status: "active",
    handoff: 0,
    handoff_answer: "Use staging",
  });
  expect((await workspace.getItemEvents({ item_id }))[0]).toMatchObject({
    kind: "answered",
    actor: { email: "member@example.test" },
  });
});

it("gives the model the selected item and the previous exchange", async () => {
  const { item_id } = await workspace.addItem(human, {
    title: "Checkout redesign",
  });
  const fetchMessage = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ content: [{ type: "text", text: "Moved it." }] }),
    );
  try {
    const response = await post(
      "/api/command",
      JSON.stringify({
        text: "no, under Goforex",
        selected_item_id: item_id,
        previous: {
          text: "goforex: fix the menu",
          summary: "Added fix the menu to a new Gofx project.",
          changes: [{ type: "project", id: "p1", created: true }],
        },
      }),
      {
        ...bindings,
        ANTHROPIC_API_KEY: "fixture-key",
        ANTHROPIC_COMMAND_MODEL: "fixture-model",
      } as typeof bindings,
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(String(fetchMessage.mock.calls[0][1]?.body));
    expect(body.system).toContain(`"selected_item":{"id":"${item_id}"`);
    const [message] = body.messages;
    expect(message.content).toContain(
      "Previous request: goforex: fix the menu",
    );
    expect(message.content).toContain('"created":true');
    expect(message.content).toMatch(/New message: no, under Goforex$/);
  } finally {
    fetchMessage.mockRestore();
  }
});

it("creates a radar-prefixed item in that project and band, under the goal", async () => {
  const project = await workspace.createProject({ name: "Zupaflow" });
  const goal = await workspace.addItem(human, {
    title: "Launch",
    project: project.id,
  });
  const next = vi
    .fn()
    .mockResolvedValueOnce(
      turn(
        "",
        call("add_item", {
          title: "Write the spec",
          parent_id: goal.item_id,
        }),
      ),
    )
    .mockResolvedValueOnce(turn("Added Write the spec under Launch."));
  const result = await runCommand(
    workspace,
    { next },
    "Launch › backlog: Write the spec",
    undefined,
    { selected_item_id: goal.item_id },
  );
  const { system, text } = next.mock.calls[0][0];
  expect(text).toBe("Launch › backlog: Write the spec");
  expect(system).toContain("'<project> <band>: <title>'");
  expect(system).toContain("backlog → leave scheduled_on unset");
  expect(system).toContain(`"selected_item":{"id":"${goal.item_id}"`);
  const [change] = result.changes;
  expect(change).toMatchObject({ type: "item" });
  expect(
    await workspace.getItem({ item_id: (change as { id: string }).id }),
  ).toMatchObject({
    title: "Write the spec",
    parent_id: goal.item_id,
    project_id: project.id,
    scheduled_on: null,
  });
});
