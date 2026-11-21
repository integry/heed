import { Workspace } from "./workspace";
import type { Limits, UsageEvent, UsageSink } from "./seams";

export { default, Workspace } from "./worker";

export const hostLimits: Limits = {
  async check(workspaceId, action) {
    if (
      workspaceId.startsWith("limited_") &&
      (action === "item.create" ||
        action === "project.create" ||
        action === "token.create")
    ) {
      return {
        ok: false,
        reason:
          "Workspace creation allowance reached. Remove an existing resource.",
      };
    }
    if (workspaceId.startsWith("limited_") && action === "push")
      return {
        ok: false,
        reason: "Push allowance reached. Flag the handoff without notifying.",
      };
    if (workspaceId.startsWith("suspended_") && action === "connect")
      return { ok: false, reason: "Workspace suspended." };
    return { ok: true };
  },
};

export class HostedWorkspace extends Workspace {
  #events: UsageEvent[] = [];
  #testGrant = false;

  issueTestGrant() {
    this.#testGrant = true;
  }

  hasTestGrant() {
    return this.#testGrant;
  }

  protected override async revokeWorkspaceGrants() {
    this.#testGrant = false;
  }

  protected override get socketLimits() {
    return hostLimits;
  }

  protected override get pushUsage(): UsageSink {
    return {
      record: async (_id, event) => {
        this.#events.push(event);
      },
    };
  }

  pushEvents() {
    return this.#events;
  }
}
