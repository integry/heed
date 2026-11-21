import type { OnboardingStatus } from "@heedwork/core";
import { useId, type ReactNode } from "react";
import { useAction, type SaveMutation } from "./workspace-controls";
import type { BuiltInScreenId } from "./web-options";

export type OnboardingScreen = "projects" | "tokens" | "notifications";

export function onboardingCompletion(
  status: OnboardingStatus,
  guidance: string,
  notificationsEnabled: boolean,
) {
  return {
    work: status.hasGoalOrProject,
    agent: status.hasToken,
    guidance: guidance.trim().length > 0,
    notifications: notificationsEnabled,
  };
}

export function GuideEmpty({
  children,
  openGuide,
  className = "empty",
}: {
  children: ReactNode;
  openGuide?: () => void;
  className?: string;
}) {
  return (
    <p className={className}>
      {children}
      {openGuide && (
        <>
          {" "}
          <button type="button" className="guide-link" onClick={openGuide}>
            Open setup guide
          </button>
        </>
      )}
    </p>
  );
}

export function DemoDataButton({
  loaded,
  live,
  save,
  onLoad,
}: {
  loaded: boolean;
  live: boolean;
  save: SaveMutation;
  onLoad?: () => void;
}) {
  const { busy, error, run } = useAction();
  return (
    <>
      <button
        type="button"
        className="subtle"
        disabled={!live || busy}
        onClick={() => {
          void run(async () => {
            await save(
              {
                type: loaded ? "REMOVE_DEMO_DATA" : "LOAD_DEMO_DATA",
                input: {},
              },
              { callerReportsError: true },
            );
            if (!loaded) onLoad?.();
          });
        }}
      >
        {loaded ? "Remove demo data" : "Load demo data"}
      </button>
      {error && <small role="alert">{error}</small>}
    </>
  );
}

export function OnboardingGuide({
  completion,
  loaded,
  live,
  save,
  hidden,
  openGoal,
  openSettings,
  openGuidance,
  onDismiss,
  onDemoLoad,
}: {
  completion: ReturnType<typeof onboardingCompletion>;
  loaded: boolean;
  live: boolean;
  save: SaveMutation;
  hidden?: readonly BuiltInScreenId[];
  openGoal: () => void;
  openSettings: (screen: OnboardingScreen) => void;
  openGuidance: () => void;
  onDismiss?: () => void;
  onDemoLoad?: () => void;
}) {
  const { busy, error, run } = useAction();
  const progressLabel = useId();
  const count = Object.values(completion).filter(Boolean).length;
  const steps = [
    {
      title: "Create your first project or goal",
      description:
        "Group related work in a project or add a goal to your radar.",
      complete: completion.work,
      actions: (
        <>
          <button
            type="button"
            className="subtle"
            disabled={!live}
            onClick={openGoal}
          >
            Add a goal
          </button>
          {!hidden?.includes("projects") && (
            <button
              type="button"
              className="subtle"
              onClick={() => openSettings("projects")}
            >
              Create a project
            </button>
          )}
        </>
      ),
    },
    {
      title: "Connect an agent",
      description:
        "Create a token and copy your MCP config for Claude Code, Cursor, or Codex.",
      complete: completion.agent,
      actions: !hidden?.includes("tokens") && (
        <button
          type="button"
          className="subtle"
          onClick={() => openSettings("tokens")}
        >
          Open API tokens
        </button>
      ),
    },
    {
      title: "Write your guidance",
      description:
        "Tell agents how to prioritize work and when to ask for your input.",
      complete: completion.guidance,
      actions: (
        <button type="button" className="subtle" onClick={openGuidance}>
          Open guidance
        </button>
      ),
    },
    {
      title: "Enable notifications",
      description: "Get agent handoffs on this device.",
      complete: completion.notifications,
      actions: !hidden?.includes("notifications") && (
        <button
          type="button"
          className="subtle"
          onClick={() => openSettings("notifications")}
        >
          Open notifications
        </button>
      ),
    },
  ];

  return (
    <div className="onboarding">
      <div className="onboarding-progress">
        <span id={progressLabel} aria-live="polite">
          {count} of {steps.length} steps complete
        </span>
        <progress
          value={count}
          max={steps.length}
          aria-labelledby={progressLabel}
        />
      </div>
      <ol className="onboarding-steps">
        {steps.map(({ title, description, actions, complete }, index) => (
          <li key={title} data-complete={complete}>
            <span className="onboarding-step" aria-hidden="true">
              {complete ? "✓" : index + 1}
            </span>
            <div>
              <h3>
                {title}
                <span className="sr-only">
                  {complete ? " (complete)" : " (incomplete)"}
                </span>
              </h3>
              <p>{description}</p>
              <div className="inline-actions">{actions}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="onboarding-actions">
        <DemoDataButton
          loaded={loaded}
          live={live}
          save={save}
          onLoad={onDemoLoad}
        />
        {onDismiss && (
          <button
            type="button"
            className="subtle"
            disabled={!live || busy}
            onClick={() => {
              void run(async () => {
                await save(
                  { type: "DISMISS_ONBOARDING", input: {} },
                  { callerReportsError: true },
                );
                onDismiss();
              });
            }}
          >
            Dismiss guide
          </button>
        )}
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
