import type { WorkspaceUser } from "@heedwork/core";
import type { CommandProvider } from "./command-provider.js";

export interface WorkspaceSession {
  workspaceId: string;
  user: WorkspaceUser;
  role: string;
}

/** Resolves browser sessions and routes agent tokens without opening a Workspace. */
export interface AuthProvider {
  /** Return the signed-in user and their current workspace, or null. */
  session(request: Request): Promise<WorkspaceSession | null>;
  /** Handle host sign-in routes under /auth/. */
  handleAuthRoute(request: Request): Promise<Response>;
  /** Start browser sign-in and resume at the given same-origin path.
   * Defaults to /auth/login with a returnTo query parameter. */
  signIn?(request: Request, returnTo: string): Response | Promise<Response>;
  /** Route a full bearer token to an existing workspace without a Durable Object lookup. */
  workspaceForToken(token: string): Promise<string | null>;
}

export type LimitAction =
  | "item.create"
  | "project.create"
  | "token.create"
  | "command"
  | "transcribe"
  | "push"
  | "connect";

export type LimitDecision = { ok: true } | { ok: false; reason: string };

/** Authorizes workspace actions and supplies a user-facing reason on refusal. */
export interface Limits {
  check(workspaceId: string, action: LimitAction): Promise<LimitDecision>;
}

export type UsageEvent =
  | {
      type: "command";
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  | { type: "transcribe"; seconds: number }
  | { type: "push"; count: number }
  | { type: "agent.write"; operation: string };

/** Receives usage in a background task registered with waitUntil. */
export interface UsageSink {
  record(workspaceId: string, event: UsageEvent): Promise<void>;
}

export interface CommandConfiguration {
  command?: CommandProvider;
  transcribe?(audio: Uint8Array): Promise<string>;
}

export interface CommandKeys {
  configuration: CommandConfiguration | null;
  managed: boolean;
}

/** Resolves model access per workspace and indicates whether the host manages its keys. */
export interface KeyProvider {
  commandProvider(workspaceId: string): Promise<CommandKeys>;
}

export interface AppSeams {
  auth: AuthProvider;
  limits: Limits;
  usage: UsageSink;
  keys: KeyProvider;
}

/** Self-hosted deployments do not meter usage. */
export const noUsage: UsageSink = { async record() {} };

export function recordUsage(
  ctx: Pick<ExecutionContext, "waitUntil">,
  sink: UsageSink,
  workspaceId: string,
  event: UsageEvent,
) {
  if (sink === noUsage) return;
  ctx.waitUntil(
    Promise.resolve()
      .then(() => sink.record(workspaceId, event))
      .catch(() => {
        console.warn("Workspace usage recording failed", event.type);
      }),
  );
}

export class LimitError extends Error {
  constructor(
    readonly action: LimitAction,
    reason: string,
    readonly status = action === "connect" ? 403 : 429,
    readonly code = "limit_exceeded",
    readonly retryAfter?: number,
  ) {
    super(reason);
  }

  get detail() {
    return { code: this.code, message: this.message, limit: this.action };
  }
}

export async function checkLimit(
  limits: Limits,
  workspaceId: string,
  action: LimitAction,
) {
  const decision = await limits.check(workspaceId, action);
  if (!decision.ok) {
    if (decision instanceof OpenLimitRefusal) throw decision.error;
    throw new LimitError(action, decision.reason);
  }
  return decision;
}

export async function withItemCreateLimit<T>(
  limits: Limits,
  workspaceId: string,
  add: () => T | Promise<T>,
  updateExisting?: () => T | null | Promise<T | null>,
): Promise<T> {
  if (updateExisting) {
    const result = await updateExisting();
    if (result !== null) return result;
  }
  try {
    await checkLimit(limits, workspaceId, "item.create");
  } catch (error) {
    // A concurrent insertion may have made this an update during the check.
    if (error instanceof LimitError && updateExisting) {
      const result = await updateExisting();
      if (result !== null) return result;
    }
    throw error;
  }
  return add();
}

export class OpenLimitRefusal {
  readonly ok = false;
  constructor(readonly error: LimitError) {}
  get reason() {
    return this.error.message;
  }
}

// The open push cap is reserved by the Workspace in the handoff transaction.
export class OpenPushAllowance {
  readonly ok = true;
  constructor(readonly cap: number) {}
}
