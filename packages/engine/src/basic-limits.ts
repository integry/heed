import { openSessionId } from "./auth.js";
import { readBearer } from "./agent-auth.js";
import { LimitError, OpenLimitRefusal, OpenPushAllowance } from "./seams.js";
import type { Limits } from "./seams.js";
import { hashSecret } from "./token-secrets.js";
import type { SeamContext } from "./app.js";

export interface BasicLimitsEnv {
  TOKEN_RATE_LIMITER: RateLimit;
  TOKEN_RATE_LIMIT_PER_MINUTE?: string;
  COMMAND_RATE_LIMIT_PER_MINUTE?: string;
  COMMAND_DAILY_LIMIT?: string;
  TRANSCRIBE_DAILY_LIMIT?: string;
  PUSH_RATE_LIMIT_PER_HOUR?: string;
}

const RATE_CAPACITY = 1_000_000;

function limitValue(raw: string | undefined, fallback: number, max: number) {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error("Invalid usage limit");
  }
  return value;
}

/** Preserves self-hosted token, command and transcription quotas. */
export function basicLimits(
  env: BasicLimitsEnv,
  { request, session, workspace }: SeamContext,
): Limits {
  return {
    async check(workspaceId, action) {
      if (action === "connect") {
        const path = new URL(request.url).pathname;
        const token =
          (path === "/mcp" || path === "/api/report") && readBearer(request);
        if (token && request.method === "POST") {
          const limit = Number(env.TOKEN_RATE_LIMIT_PER_MINUTE ?? 60);
          if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
            throw new Error(
              "TOKEN_RATE_LIMIT_PER_MINUTE must be an integer from 1 to 1000",
            );
          const { success } = await env.TOKEN_RATE_LIMITER.limit({
            key: await hashSecret(token),
            delta: Math.ceil(RATE_CAPACITY / limit),
          });
          if (!success)
            return new OpenLimitRefusal(
              new LimitError(
                action,
                "Rate limit exceeded",
                429,
                "rate_limited",
                60,
              ),
            );
        }
      }

      if (action === "command" || action === "transcribe") {
        let perMinute: number;
        let daily: number;
        try {
          perMinute = limitValue(env.COMMAND_RATE_LIMIT_PER_MINUTE, 8, 1_000);
          daily = limitValue(
            action === "command"
              ? env.COMMAND_DAILY_LIMIT
              : env.TRANSCRIBE_DAILY_LIMIT,
            100,
            100_000,
          );
        } catch {
          return new OpenLimitRefusal(
            new LimitError(
              action,
              "The command bar usage limits are misconfigured.",
              503,
              "invalid_configuration",
            ),
          );
        }
        const sessionId = openSessionId(request) ?? session()?.user.id;
        if (sessionId) {
          const { success } = await env.TOKEN_RATE_LIMITER.limit({
            key: `${action}:${await hashSecret(sessionId)}`,
            delta: Math.floor(RATE_CAPACITY / perMinute),
          });
          if (!success)
            return new OpenLimitRefusal(
              new LimitError(
                action,
                "Too many requests. Try again in a minute.",
                429,
                "rate_limited",
                60,
              ),
            );
        }
        if (
          !(await workspace(workspaceId).reserveCommandQuota(action, daily))
        ) {
          const seconds = 86_400 - Math.floor((Date.now() % 86_400_000) / 1000);
          return new OpenLimitRefusal(
            new LimitError(
              action,
              "The workspace daily limit has been reached. Try again after midnight UTC.",
              429,
              "rate_limited",
              seconds,
            ),
          );
        }
      }
      if (action === "push") return new OpenPushAllowance(basicPushCap(env));
      return { ok: true };
    },
  };
}

export function basicPushCap(
  env: Pick<BasicLimitsEnv, "PUSH_RATE_LIMIT_PER_HOUR">,
) {
  const limit = Number(env.PUSH_RATE_LIMIT_PER_HOUR ?? 6);
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : 6;
}
