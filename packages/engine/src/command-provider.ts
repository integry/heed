import { z } from "zod";
import type { ToolDefinition } from "./command-tools.js";

import type { KeyProvider } from "./seams.js";

export interface EnvKeysEnv {
  AI?: Ai;
  WORKERS_AI_COMMAND_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_COMMAND_MODEL?: string;
  /** Anthropic-compatible Messages endpoint, such as OpenRouter's. Defaults to Anthropic. */
  ANTHROPIC_MESSAGES_URL?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface CommandTurn {
  text: string;
  calls: ToolCall[];
  /** Provider-reported token counts for this model call, when available. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ToolReply {
  call: ToolCall;
  content: string;
  isError: boolean;
}

export interface CommandExchange {
  turn: CommandTurn;
  replies: ToolReply[];
}

export interface CommandProvider {
  /** Model identifier used when recording usage. */
  model?: string;
  next(input: {
    system: string;
    text: string;
    tools: ToolDefinition[];
    history: CommandExchange[];
  }): Promise<CommandTurn>;
}

const tokenCount = z.int().nonnegative();
const workersUsage = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
});
const anthropicUsage = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
});
const transcriptSchema = z.object({ text: z.string() });

const anthropicMessage = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
      z.object({ type: z.string() }),
    ]),
  ),
});
const toolFunction = z.object({ name: z.string(), arguments: z.unknown() });
const aiToolCall = z.union([
  z.object({ id: z.string().optional(), function: toolFunction }),
  toolFunction,
]);
const nativeResponse = z
  .object({
    response: z.string().nullish(),
    tool_calls: z.array(aiToolCall).nullish(),
  })
  .refine(({ response, tool_calls }) => response != null || tool_calls != null);
const chatResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(aiToolCall).nullish(),
        }),
      }),
    )
    .min(1),
});

function toolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function commandProvider(env: EnvKeysEnv): CommandProvider | undefined {
  const {
    AI,
    WORKERS_AI_COMMAND_MODEL,
    ANTHROPIC_COMMAND_MODEL,
    ANTHROPIC_API_KEY,
    ANTHROPIC_MESSAGES_URL,
  } = env;
  if (ANTHROPIC_COMMAND_MODEL?.trim() && ANTHROPIC_API_KEY?.trim()) {
    return {
      model: ANTHROPIC_COMMAND_MODEL,
      async next({ system, text, tools, history }) {
        const url =
          ANTHROPIC_MESSAGES_URL?.trim() ||
          "https://api.anthropic.com/v1/messages";
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(25_000),
          body: JSON.stringify({
            model: ANTHROPIC_COMMAND_MODEL,
            max_tokens: 768,
            system,
            tools: tools.map(({ parameters, ...tool }) => ({
              ...tool,
              input_schema: parameters,
            })),
            messages: [
              { role: "user", content: text },
              ...history.flatMap(({ turn, replies }) => [
                {
                  role: "assistant",
                  content: [
                    ...(turn.text ? [{ type: "text", text: turn.text }] : []),
                    ...turn.calls.map(({ id, name, input }) => ({
                      type: "tool_use",
                      id,
                      name,
                      input,
                    })),
                  ],
                },
                {
                  role: "user",
                  content: replies.map(({ call, content, isError }) => ({
                    type: "tool_result",
                    tool_use_id: call.id,
                    content,
                    is_error: isError,
                  })),
                },
              ]),
            ],
          }),
        });
        if (!response.ok) {
          void response.body?.cancel();
          throw new Error(`Anthropic command failed (${response.status})`);
        }
        const data = await response.json<{ usage?: unknown }>();
        const { content } = anthropicMessage.parse(data);
        const usage = anthropicUsage.safeParse(data.usage);
        return {
          ...(usage.success && {
            usage: {
              inputTokens: usage.data.input_tokens,
              outputTokens: usage.data.output_tokens,
            },
          }),
          text: content
            .flatMap((block) => ("text" in block ? [block.text] : []))
            .join("\n"),
          calls: content.flatMap((block) =>
            "input" in block
              ? [{ id: block.id, name: block.name, input: block.input }]
              : [],
          ),
        };
      },
    };
  }
  if (AI && WORKERS_AI_COMMAND_MODEL?.trim()) {
    return {
      model: WORKERS_AI_COMMAND_MODEL,
      async next({ system, text, tools, history }) {
        const messages = [
          { role: "system", content: system },
          { role: "user", content: text },
          ...history.flatMap(({ turn, replies }) => [
            {
              role: "assistant",
              content: turn.text,
              tool_calls: turn.calls.map(({ id, name, input }) => ({
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              })),
            },
            ...replies.map(({ call, content }) => ({
              role: "tool",
              name: call.name,
              tool_call_id: call.id,
              content,
            })),
          ]),
        ];
        const response: unknown = await AI.run(
          WORKERS_AI_COMMAND_MODEL,
          {
            messages,
            tools: tools.map((definition) => ({
              type: "function",
              function: definition,
            })),
            max_tokens: 768,
            stream: false,
          },
          { signal: AbortSignal.timeout(25_000) },
        );
        const native = nativeResponse.safeParse(response);
        const message = native.success
          ? {
              content: native.data.response,
              tool_calls: native.data.tool_calls,
            }
          : chatResponse.parse(response).choices[0].message;
        const usage = workersUsage.safeParse(
          (response as { usage?: unknown })?.usage,
        );
        return {
          ...(usage.success && {
            usage: {
              inputTokens: usage.data.prompt_tokens,
              outputTokens: usage.data.completion_tokens,
            },
          }),
          text: message.content ?? "",
          calls: (message.tool_calls ?? []).map((call, i) => {
            const fn = "function" in call ? call.function : call;
            const id = "id" in call ? call.id : undefined;
            return {
              id: id ?? `call_${history.length}_${i}`,
              name: fn.name,
              input: toolInput(fn.arguments),
            };
          }),
        };
      },
    };
  }
}

/** Uses self-hosted model settings and the Workers AI binding when available. */
export function envKeys(env: EnvKeysEnv): KeyProvider {
  return {
    async commandProvider() {
      const command = commandProvider(env);
      const ai = env.AI;
      return {
        managed: false,
        configuration:
          command || ai
            ? {
                command,
                transcribe: ai
                  ? async (audio) => {
                      const base64 = (
                        audio as Uint8Array & { toBase64(): string }
                      ).toBase64();
                      const result = transcriptSchema.parse(
                        await ai.run(
                          "@cf/openai/whisper-large-v3-turbo",
                          { audio: base64 },
                          { signal: AbortSignal.timeout(25_000) },
                        ),
                      );
                      return result.text;
                    }
                  : undefined,
              }
            : null,
      };
    },
  };
}
