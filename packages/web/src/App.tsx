import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  COMMAND_HELP,
  RESET_WORKSPACE_CONFIRMATION,
  interpretCommand,
  effectiveSchedule,
  progress,
  isBlocked,
  matchCommandName,
  needsMe,
  type CommandCapabilities,
  type ConnectedApp,
  type CreatedToken,
  type Dependency,
  type Event,
  type HistoryPage,
  type Item,
  type RadarBand,
  type Scope,
  type TokenMetadata,
} from "@heedwork/core";
import { CommandBar, useCommandBar } from "./CommandBar";
import { AttentionStream } from "./AttentionStream";
import { SelectedItem } from "./SelectedItem";
import { isDescendant } from "./dependency-graph";
import { Guidance } from "./Guidance";
import {
  ConfirmCommand,
  ShadowJudgeAgreement,
  TokenLabel,
  TokenSecret,
} from "./CommandPanels";
import { QuestionBubble } from "./QuestionBubble";
import { ItemActivity } from "./ItemActivity";
import { EnableNotifications, runPushCommand } from "./push-commands";
import { lensRegistry, resolveLens, type Lens } from "./lenses";
import { isRadarRowVisible } from "./RadarLens";
import { StreamHistory } from "./stream-history";
import { createWorkspaceConnection } from "./workspace-connection";
import {
  dateLabel,
  Panel,
  timeInputInstant,
  useAction,
} from "./workspace-controls";
import { ApiContext, createApi, useApi, useResource } from "./api";
import type { AppUser, BuiltInScreenId, MountAppOptions } from "./web-options";
import { workspaceView, type MutationInput } from "./workspace-state";
import { selectWorkspace } from "./workspace-view";

type PanelState =
  | {
      kind: "guidance" | "host" | "history" | "hidden" | "judge" | "push";
    }
  | {
      kind: "token-label";
      scope: Scope;
      project?: { id: string; title: string };
    }
  | { kind: "token"; created: CreatedToken }
  | {
      kind: "list";
      title: string;
      rows: { id: string; title: string; detail?: string }[];
    }
  | {
      kind: "confirm";
      title: string;
      phrase: string;
      description: string;
      mutation: MutationInput;
      result: string;
    };

type Session =
  | { status: "loading" }
  | { status: "error"; message?: string }
  | { status: "signed-out"; devLoginEnabled: boolean }
  | {
      status: "signed-in";
      user: AppUser;
      role: string;
      managed?: boolean;
      workspaceId: string;
      capabilities: CommandCapabilities;
    };

function Wordmark() {
  return <span className="wordmark">heed</span>;
}

function hasOpenHandoff(item: Item) {
  return (
    item.handoff === 1 && item.status !== "done" && item.status !== "cancelled"
  );
}

function useMinuteClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    function tick() {
      clearTimeout(timeout);
      const time = Date.now();
      setNow(time);
      // Align to the minute boundary so the clock also ticks at local midnight.
      timeout = setTimeout(tick, 60_000 - (time % 60_000));
    }
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}

const connectionLabels = {
  connecting: "Connecting to workspace…",
  reconnecting: "Reconnecting to workspace…",
  syncing: "Synchronizing workspace…",
};

function ErrorBanner({
  message,
  dismiss,
}: {
  message: string;
  dismiss: () => void;
}) {
  return (
    <div className="error-banner">
      <p role="alert">{message}</p>
      <button type="button" className="subtle" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}

function Workspace({
  session,
  options,
  registry,
  onSessionExpired,
  onWorkspaceChange,
}: {
  session: Extract<Session, { status: "signed-in" }>;
  options?: MountAppOptions;
  registry: readonly [Lens, ...Lens[]];
  onSessionExpired: (devLoginEnabled?: boolean) => void;
  onWorkspaceChange: () => void;
}) {
  const { user, workspaceId, role, managed, capabilities } = session;
  const workspaceApi = useApi();
  const { getJson, postJson } = workspaceApi;
  const api = useMemo(
    () => ({ getJson, postJson, useResource }),
    [getJson, postJson],
  );
  const screenProps = { user, workspaceId, role, api };
  const slotProps = { ...screenProps, onWorkspaceChange };
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const node = shell.current;
    if (!viewport || !node) return;
    function resize() {
      if (viewport && viewport.scale === 1)
        node?.style.setProperty("--attention-height", `${viewport.height}px`);
    }
    resize();
    viewport.addEventListener("resize", resize);
    return () => viewport.removeEventListener("resize", resize);
  }, []);
  const HeaderStart = options?.headerStart;
  const HeaderEnd = options?.headerEnd;
  const signOut = options?.onSignOut;
  const [lensId, setLensId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<{
    id: string;
    fromNotification?: boolean;
  } | null>(() => {
    const id = new URLSearchParams(window.location.search).get("item");
    return id ? { id, fromNotification: true } : null;
  });
  const selectedId = selectedItem?.id ?? null;
  const [connection] = useState(() => createWorkspaceConnection(selectedId));
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
  );
  const { notificationItemVersion } = state;
  const [linkedItem, setLinkedItem] = useState<{
    item: Item;
    version: number;
  }>();
  const [goalId, focusGoal] = useState<string | null>(null);
  const [radarSelection, setRadarSelection] = useState<string | null>(null);
  // Dependency saves can outlive the graph that submitted them.
  const [dependencyEditGoal, setDependencyEditGoal] = useState<string | null>(
    null,
  );
  const dependencyEdit = useAction();
  const [showGhosts, setShowGhosts] = useState(true);
  const [activePanel, setActivePanel] = useState<PanelState | null>(null);
  const panel = activePanel?.kind;
  const [radarZoom, setRadarZoom] = useState<{ band: RadarBand | null }>();
  const [replyId, setReplyId] = useState<string>();
  const clock = useMinuteClock();
  const command = useCommandBar(
    connection.save,
    capabilities.transcription,
    capabilities.command,
    executeCommand,
  );
  const view = useMemo(() => workspaceView(state), [state]);
  const derived = useMemo(() => {
    // A broadcast can carry a heartbeat newer than the last clock tick.
    const now = Math.max(clock, Date.now());
    return { ...selectWorkspace(view, now), now };
  }, [view, clock]);
  const { projects, tree, filtered, liveCount, timezone, now } = derived;
  const focusedGoal = goalId && filtered.has(goalId) ? goalId : null;
  const lens = resolveLens(registry, lensId);
  const LensComponent = lens.component;
  const live = state.connection === "live";
  const dependencyError = dependencyEditGoal ? dependencyEdit.error : "";
  const showDependencyErrorInline =
    lens.id === "dependencies" && focusedGoal === dependencyEditGoal;
  const selection = selectedId && filtered.has(selectedId) ? selectedId : null;
  const radarLens = registry.find(({ id }) => id === "radar");
  const dependenciesLens = registry.find(({ id }) => id === "dependencies");
  const selected = selectedId ? state.items.get(selectedId) : undefined;
  const linkedId =
    selectedItem?.fromNotification && !selected ? selectedId : null;
  useEffect(() => {
    if (!linkedId || !live) return;
    const controller = new AbortController();
    void getJson<Item>(
      `/api/items/${encodeURIComponent(linkedId)}`,
      controller.signal,
    )
      .catch(() => undefined)
      .then((item) => {
        const current = connection.getSnapshot();
        if (
          !controller.signal.aborted &&
          current.connection === "live" &&
          current.notificationItemVersion === notificationItemVersion
        ) {
          setLinkedItem(
            item ? { item, version: notificationItemVersion } : undefined,
          );
        }
      });
    return () => controller.abort();
  }, [connection, getJson, linkedId, live, notificationItemVersion]);
  const fallback =
    linkedItem?.version === notificationItemVersion &&
    linkedItem.item.id === linkedId
      ? linkedItem.item
      : undefined;
  const inspected = selected ?? fallback;
  const replyTarget =
    replyId && inspected?.id === replyId && hasOpenHandoff(inspected)
      ? inspected
      : undefined;
  const { setDraft } = command;
  useEffect(() => {
    if (replyId && !replyTarget) {
      setReplyId(undefined);
      setDraft("");
    }
  }, [replyId, replyTarget, setDraft]);
  const dependencies = useMemo(
    () => [...view.dependencies.values()],
    [view.dependencies],
  );
  const inspectedGoal = inspected ? dependencyGoal(inspected.id) : null;
  // A save can finish after its panel has been replaced by another.
  const closePanel = () =>
    setActivePanel((current) => (current === activePanel ? null : current));
  const openHistoryIds = useMemo(
    () =>
      new Set(
        [...state.items.values()]
          .filter(({ status }) => status !== "done" && status !== "cancelled")
          .map(({ id }) => id),
      ),
    [state.items],
  );
  const pendingReopens = useMemo(
    () =>
      new Set(
        [...state.pending.values()].flatMap((mutation) =>
          mutation.type === "REOPEN_ITEM" && mutation.input.item_id
            ? [mutation.input.item_id]
            : [],
        ),
      ),
    [state.pending],
  );

  useEffect(
    () => connection.start(onSessionExpired),
    [connection, onSessionExpired],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        panel ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        (event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
          ))
      )
        return;
      if (!/^[1-4]$/.test(event.key)) return;
      const next = registry[Number(event.key) - 1];
      if (next) {
        event.preventDefault();
        setLensId(next.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel, registry]);

  function updateItem(
    item_id: string,
    patch: Omit<
      Extract<MutationInput, { type: "UPDATE_ITEM" }>["input"],
      "item_id"
    >,
  ) {
    connection.mutate({ type: "UPDATE_ITEM", input: { item_id, ...patch } });
  }

  function changeDependency(edge: Dependency, action: "add" | "remove") {
    if (!live || !focusedGoal) return;
    void dependencyEdit.run(() => {
      setDependencyEditGoal(focusedGoal);
      return connection.save(
        { type: "SET_DEPENDENCY", input: { ...edge, action } },
        { callerReportsError: true },
      );
    });
  }

  function dependencyGoal(id: string) {
    if (
      focusedGoal &&
      (id === focusedGoal || isDescendant(id, focusedGoal, view.items))
    )
      return focusedGoal;
    let root = view.items.get(id);
    while (root?.parent_id) root = view.items.get(root.parent_id);
    return root && filtered.has(root.id) ? root.id : null;
  }

  function selectStreamItem(id: string) {
    setReplyId(undefined);
    setSelectedItem({ id });
    setRadarSelection(null);
    if (lens.id === "dependencies") {
      if (!focusedGoal) focusGoal(dependencyGoal(id));
      return;
    }
    if (id === focusedGoal) return;
    const focusForRadar = lens.id === "radar" || lens.id === "list";
    let parent = view.items.get(id)?.parent_id ?? null;
    while (parent) {
      const row = filtered.get(parent);
      if (row && (!focusForRadar || isRadarRowVisible(row, showGhosts))) break;
      parent = view.items.get(parent)?.parent_id ?? null;
    }
    focusGoal(parent);
  }

  function placeItem(
    id: string,
    key: string,
    position: Record<string, number>,
    patch: { scheduled_on?: string | null; project?: string } = {},
  ) {
    const item = workspaceView(connection.getSnapshot()).items.get(id);
    if (!item) return;
    const positions = JSON.parse(item.layout_pos) as Record<
      string,
      Record<string, number>
    >;
    updateItem(id, {
      ...patch,
      layout_pos: { ...positions, [key]: position },
    });
  }

  function eventRevision(id: string) {
    return `${state.snapshotRevision}:${state.eventRevisions.get(id) ?? 0}`;
  }

  const activity = useResource<Event[]>(
    inspected ? `/api/items/${encodeURIComponent(inspected.id)}/events` : null,
    inspected &&
      JSON.stringify([
        eventRevision(inspected.id),
        inspected.completed_at,
        inspected.reopen_count,
      ]),
  );

  const hiddenItems =
    panel === "hidden"
      ? [...view.items.values()]
          .filter((item) => item.hidden === 1 && item.parent_id === null)
          .sort((a, b) => a.title.localeCompare(b.title))
      : [];
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(now);
  const openGraph =
    dependenciesLens &&
    inspectedGoal &&
    (lens.id !== "dependencies" || focusedGoal !== inspectedGoal)
      ? () => {
          focusGoal(inspectedGoal);
          setLensId(dependenciesLens.id);
        }
      : undefined;

  const visibleItems = [...view.items.values()].filter(
    (item) =>
      derived.visibleIds.has(item.id) &&
      item.status !== "done" &&
      item.status !== "cancelled",
  );
  const questions: Item[] = visibleItems.filter(hasOpenHandoff);
  if (
    inspected &&
    hasOpenHandoff(inspected) &&
    !questions.some(({ id }) => id === inspected.id)
  )
    questions.push(inspected);

  function allowed(screen: BuiltInScreenId) {
    if (options?.hideScreens?.includes(screen))
      throw new Error("This command is unavailable in this workspace.");
  }

  async function saveCommand(mutation: MutationInput, result: string) {
    const ack = await connection.save(mutation, { callerReportsError: true });
    if (mutation.type === "CREATE_TOKEN") {
      if (!ack.createdToken)
        throw new Error(
          "The token response was missing. Check the token list.",
        );
      setActivePanel({ kind: "token", created: ack.createdToken });
    }
    if (mutation.type === "RESET_WORKSPACE") {
      setSelectedItem(null);
      setRadarSelection(null);
      setReplyId(undefined);
      focusGoal(null);
      setLensId(null);
      setRadarZoom(undefined);
    }
    return ack.ignored_fields?.length
      ? `Skipped ${ack.ignored_fields.join(", ")}.`
      : result;
  }

  function confirmMutation(mutation: MutationInput, result: string) {
    const details = (() => {
      switch (mutation.type) {
        case "RESET_WORKSPACE":
          return {
            title: "Reset workspace",
            phrase: RESET_WORKSPACE_CONFIRMATION,
            description:
              "Permanently delete workspace data, revoke tokens and connected apps, and remove push subscriptions. The workspace starts over with an empty Inbox.",
          };
        case "DELETE_ITEM":
          return {
            title: "Delete item",
            phrase: "DELETE ITEM",
            description: result
              .replace(/^Deleted /, "Permanently delete ")
              .replace(/\.$/, "?"),
          };
        case "DELETE_PROJECT":
          return {
            title: "Delete project",
            phrase: "DELETE PROJECT",
            description: result
              .replace(/^Deleted /, "Permanently delete ")
              .replace(/\.$/, "?"),
          };
        default:
          return {
            title: "Revoke access",
            phrase: "REVOKE ACCESS",
            description: result
              .replace(/^Revoked /, "Revoke ")
              .replace(/\.$/, "?"),
          };
      }
    })();
    setActivePanel({ kind: "confirm", ...details, mutation, result });
  }

  async function answerQuestion(id: string, text: string) {
    const item = connection.getSnapshot().items.get(id) ?? inspected;
    const result = await saveCommand(
      { type: "ANSWER_HANDOFF", input: { item_id: id, text } },
      `Answered “${item?.title ?? "question"}”.`,
    );
    command.setSummary(result);
  }

  async function executeCommand(text: string): Promise<string | undefined> {
    if (replyId && !replyTarget) return "That question is no longer open.";
    const context = {
      selected: inspected,
      items:
        inspected && !view.items.has(inspected.id)
          ? [...view.items.values(), inspected]
          : [...view.items.values()],
      replyTo: replyTarget,
      today: Date.now(),
      timezone,
      projects,
      lenses: registry,
    };
    const intent = interpretCommand(text, context);
    switch (intent.type) {
      case "unknown":
        if (options?.freeText)
          return (await options.freeText(text, context)).text;
        return capabilities.command ? undefined : COMMAND_HELP;
      case "message":
        return intent.text;
      case "token-label":
        allowed("tokens");
        setActivePanel({
          kind: "token-label",
          scope: intent.scope,
          project: intent.project,
        });
        return "";
      case "select":
        selectStreamItem(intent.id);
        return `Selected “${context.items.find(({ id }) => id === intent.id)?.title}”.`;
      case "details": {
        const canvasItem = view.items.get(intent.id);
        const item = canvasItem ?? inspected;
        if (!item) return "That item is unavailable.";
        const project =
          view.projects.get(item.project_id)?.name ?? item.project_id;
        const schedule = effectiveSchedule(item, view.items) ?? "Unscheduled";
        const time =
          item.time_type !== "flexible" && item.time_at
            ? `${item.time_type === "deadline" ? "Due" : "Fixed"} ${dateLabel(item.time_at, timezone)}`
            : undefined;
        const tags = JSON.parse(item.tags) as string[];
        const locks = JSON.parse(item.locked_fields) as string[];
        const children =
          canvasItem?.progress ?? progress(item, [...view.items.values()]);
        return [
          item.title,
          item.status,
          project,
          schedule,
          time,
          `Priority ${item.priority}`,
          tags.length ? `Tags ${tags.join(", ")}` : undefined,
          locks.length ? `Locked ${locks.join(", ")}` : undefined,
          children.total
            ? `${children.done} of ${children.total} children complete`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
      }
      case "lens":
        if (intent.id === "dependencies" && inspectedGoal)
          focusGoal(inspectedGoal);
        setLensId(intent.id);
        return `${registry.find(({ id }) => id === intent.id)?.label} lens.`;
      case "zoom":
        if (!radarLens) return "Radar is unavailable.";
        focusGoal(null);
        setLensId(radarLens.id);
        setRadarZoom({ band: intent.band });
        return intent.band
          ? `Zoomed into ${intent.band.replace("-", " ")}.`
          : "Whole radar.";
      case "time":
        return saveCommand(
          {
            type: "UPDATE_ITEM",
            input: {
              item_id: intent.id,
              scheduled_on: intent.date,
              time_type: intent.kind,
              time_at: timeInputInstant(
                `${intent.date}T${intent.time}`,
                timezone,
              ),
            },
          },
          `Updated the time for “${intent.title}”.`,
        );
      case "mutate":
        if (intent.mutation.type === "CREATE_TOKEN") allowed("tokens");
        if (
          [
            "CREATE_PROJECT",
            "UPDATE_PROJECT",
            "MOVE_PROJECT",
            "DELETE_PROJECT",
          ].includes(intent.mutation.type)
        )
          allowed("projects");
        if (intent.mutation.type === "SET_TIMEZONE") allowed("account");
        if (intent.confirm) {
          confirmMutation(intent.mutation, intent.text);
          return "";
        }
        return saveCommand(intent.mutation, intent.text);
      case "reopen-history": {
        const query = new URLSearchParams({
          q: intent.name.startsWith('"')
            ? intent.name.replace(/^"(.+)"$/, "$1")
            : intent.name.replace(/^the /i, ""),
          limit: "100",
        });
        const page = await getJson<HistoryPage>(`/api/history?${query}`);
        const matches = matchCommandName(intent.name, page.items);
        if (page.next_before)
          return "Use a more specific item name or open history.";
        if (matches.length !== 1)
          return matches.length
            ? `Matches ${matches.map(({ title }) => title).join(", ")}.`
            : `No match for “${intent.name}”.`;
        const [{ id, title }] = matches;
        return saveCommand(
          {
            type: "REOPEN_ITEM",
            input: { item_id: id, reason: intent.reason },
          },
          `Reopened “${title}”.`,
        );
      }
      case "revoke": {
        allowed("tokens");
        const rows =
          intent.kind === "token"
            ? (await getJson<TokenMetadata[]>("/api/tokens")).map(
                ({ id, label }) => ({ id, title: label }),
              )
            : (await getJson<ConnectedApp[]>("/api/connected-apps")).map(
                ({ id, client_name, label }) => ({
                  id,
                  title: `${client_name} · ${label}`,
                }),
              );
        const matches = matchCommandName(intent.name, rows);
        if (matches.length !== 1)
          return matches.length
            ? `Matches ${matches.map(({ title }) => title).join(", ")}.`
            : `No match for “${intent.name}”.`;
        const [{ id, title }] = matches;
        confirmMutation(
          intent.kind === "token"
            ? { type: "REVOKE_TOKEN", input: { token_id: id } }
            : { type: "REVOKE_CONNECTED_APP", input: { grant_id: id } },
          `Revoked “${title}”.`,
        );
        return "";
      }
      case "workspace":
        switch (intent.command) {
          case "what needs me":
          case "what is blocked": {
            const needs = intent.command === "what needs me";
            const matches = visibleItems.filter((item) =>
              needs
                ? needsMe(item, now)
                : isBlocked(item, view.items, dependencies),
            );
            if (!matches.length)
              return needs ? "Nothing needs you." : "Nothing is blocked.";
            return `${needs ? "Needs you" : "Blocked"} · ${matches.map(({ title }) => title).join(", ")}`;
          }
          case "edit guidance":
            if (!state.settings)
              return "Guidance will be available when the workspace connects.";
            setActivePanel({ kind: "guidance" });
            return "";
          case "history":
          case "hidden items":
            setActivePanel({
              kind: intent.command === "history" ? "history" : "hidden",
            });
            return "";
          case "show completed ghosts":
          case "hide completed ghosts":
            setShowGhosts(intent.command === "show completed ghosts");
            return intent.command === "show completed ghosts"
              ? "Showing completed ghosts."
              : "Completed ghosts hidden.";
          case "enable notifications":
            allowed("notifications");
            setActivePanel({ kind: "push" });
            return "";
          case "disable notifications":
          case "test notification":
            allowed("notifications");
            return runPushCommand(workspaceApi, intent.command);
          case "export workspace": {
            allowed("data");
            const link = document.createElement("a");
            link.href = "/api/export";
            link.download = "";
            link.click();
            return "Workspace export requested.";
          }
          case "reset workspace":
            allowed("data");
            confirmMutation(
              {
                type: "RESET_WORKSPACE",
                input: { confirmation: RESET_WORKSPACE_CONFIRMATION },
              },
              "Workspace reset. Your Inbox is now empty.",
            );
            return "";
          case "list projects":
            allowed("projects");
            setActivePanel({
              kind: "list",
              title: "Projects",
              rows: projects.map(({ id, name, hidden }) => ({
                id,
                title: name,
                detail: hidden ? "Hidden" : undefined,
              })),
            });
            return "";
          case "list tokens":
          case "connected apps": {
            allowed("tokens");
            const tokens = intent.command === "list tokens";
            const rows = tokens
              ? (await getJson<TokenMetadata[]>("/api/tokens")).map(
                  ({ id, label, scope, default_project_id, last_used_at }) => ({
                    id,
                    title: label,
                    detail: `${scope} · ${projects.find(({ id }) => id === default_project_id)?.name ?? "Inbox"} · ${last_used_at ? `Last used ${new Date(last_used_at).toLocaleString()}` : "Never used"}`,
                  }),
                )
              : (await getJson<ConnectedApp[]>("/api/connected-apps")).map(
                  ({ id, label, client_name, scope, last_used_at }) => ({
                    id,
                    title: `${client_name} · ${label}`,
                    detail: `${scope} · ${last_used_at ? `Last used ${new Date(last_used_at).toLocaleString()}` : "Never used"}`,
                  }),
                );
            setActivePanel({
              kind: "list",
              title: tokens ? "API tokens" : "Connected apps",
              rows,
            });
            return "";
          }
          case "shadow judge":
            allowed("shadow-judge");
            setActivePanel({ kind: "judge" });
            return "";
          case "model keys":
            allowed("model-keys");
            if (capabilities.command) return "A command model is configured.";
            return managed === false
              ? "Configure Workers AI or an Anthropic key to enable model-assisted commands."
              : "Model availability is managed by your host.";
          case "account":
            allowed("account");
            return `Signed in as ${user.email} · Workspace timezone ${timezone}.`;
          case "sign out":
            if (signOut) await signOut();
            else {
              const response = await fetch("/auth/logout", { method: "POST" });
              if (!response.ok)
                throw new Error("Couldn’t sign out. Try again.");
            }
            onSessionExpired();
            return "";
        }
    }
  }

  return (
    <div className="attention-app" ref={shell}>
      <header className="attention-header">
        <details className="wordmark-menu">
          <summary aria-label="Heed workspace menu">
            <Wordmark />
          </summary>
          <div
            className="wordmark-actions"
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("button, a")
              )
                event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            {HeaderStart && <HeaderStart {...slotProps} />}
            {lens.id === "dependencies" && radarLens && (
              <button
                className="text-control"
                type="button"
                onClick={() => setLensId(radarLens.id)}
              >
                Back to Radar
              </button>
            )}
            <button
              className="text-control"
              type="button"
              onClick={() => {
                command.setDraft("add ");
                command.line.current?.focus({ preventScroll: true });
              }}
              disabled={!live}
            >
              Add item
            </button>
            <button
              className="text-control"
              type="button"
              onClick={() => setActivePanel({ kind: "history" })}
            >
              History
            </button>
            <button
              className="text-control"
              type="button"
              onClick={() => setActivePanel({ kind: "hidden" })}
            >
              Hidden items
            </button>
            <button
              className="text-control"
              type="button"
              onClick={() => setShowGhosts(!showGhosts)}
            >
              {showGhosts ? "Hide completed ghosts" : "Show completed ghosts"}
            </button>
            <button
              className="text-control"
              type="button"
              onClick={() => setActivePanel({ kind: "guidance" })}
              disabled={!state.settings}
            >
              Guidance
            </button>
            {!!options?.extraSettingsScreens?.length && (
              <button
                className="text-control"
                type="button"
                onClick={() => setActivePanel({ kind: "host" })}
              >
                Settings
              </button>
            )}
            {HeaderEnd && <HeaderEnd {...slotProps} />}
          </div>
        </details>
        <div className="attention-meta">
          <span>
            <span
              className="agent-dot"
              data-live={live && liveCount > 0}
              aria-hidden="true"
            >
              ●
            </span>{" "}
            {liveCount} {liveCount === 1 ? "agent" : "agents"} working
          </span>
          <time>{date}</time>
        </div>
      </header>

      <main className="attention-stage">
        <section
          className="attention-field"
          data-lens={lens.id}
          aria-keyshortcuts="1 2 3 4"
          aria-label={lens.id === "radar" ? "Attention field" : lens.label}
        >
          <h1 className="day-sentence">
            <span data-needs={derived.groups.needs.length > 0}>
              {derived.sentence.attention}
            </span>{" "}
            <span>{derived.sentence.outlook}</span>
          </h1>
          <div className="attention-lens">
            <LensComponent
              tree={tree}
              projects={projects}
              items={view.items}
              filtered={filtered}
              changeDependency={changeDependency}
              savingDependency={dependencyEdit.busy}
              dependencies={dependencies}
              selectedId={selection}
              now={now}
              timezone={timezone}
              live={live}
              showGhosts={showGhosts}
              goalId={focusedGoal}
              focusGoal={focusGoal}
              openDependencies={
                dependenciesLens && focusedGoal
                  ? () => setLensId(dependenciesLens.id)
                  : undefined
              }
              select={(id) => {
                if (lens.id === "list" && id) selectStreamItem(id);
                else {
                  setReplyId(undefined);
                  setSelectedItem(id ? { id } : null);
                  setRadarSelection(id);
                }
              }}
              radarZoom={radarZoom}
              save={connection.save}
              move={connection.mutate}
              reschedule={(id, date) => updateItem(id, { scheduled_on: date })}
              moveProject={(id, project) => updateItem(id, { project })}
              setPriority={(id, priority) => updateItem(id, { priority })}
              setPosition={(id, position) => placeItem(id, lens.id, position)}
              moveRadar={(id, { position, ...patch }, key = "radar") =>
                placeItem(id, key, position, patch)
              }
            />
          </div>
          {dependencyError && showDependencyErrorInline && (
            <p className="action-error" role="alert">
              {dependencyError}
            </p>
          )}
          {questions.length > 0 && (
            <div className="field-questions">
              {questions.map((item) => (
                <QuestionBubble
                  key={item.id}
                  item={item}
                  disabled={!live || command.action.busy}
                  typeReplyDisabled={command.clarification}
                  answer={(text) => answerQuestion(item.id, text)}
                  typeReply={() => {
                    if (item.id !== selectedId) selectStreamItem(item.id);
                    setReplyId(item.id);
                    command.setDraft("");
                    command.setSummary(
                      `Replying to ${item.agent_name ?? item.title}.`,
                    );
                    command.line.current?.focus({ preventScroll: true });
                  }}
                />
              ))}
            </div>
          )}
          {inspected && (
            <SelectedItem
              key={inspected.id}
              item={inspected}
              activity={activity}
              openGraph={openGraph}
              close={() => {
                setSelectedItem(null);
                setRadarSelection(null);
                setReplyId(undefined);
              }}
            />
          )}
        </section>
        <AttentionStream
          groups={derived.groups}
          timezone={timezone}
          items={view.items}
          now={now}
          selectedId={selectedId}
          radarSelection={radarSelection}
          select={selectStreamItem}
          activity={
            inspected && (
              <ItemActivity
                key={inspected.id}
                item={inspected}
                activity={activity}
                timezone={timezone}
                live={live}
                save={connection.save}
              />
            )
          }
        />
      </main>

      <footer className="attention-footer">
        {state.connection !== "live" && (
          <p className="connection-status" role="status">
            {connectionLabels[state.connection]}
          </p>
        )}
        {state.error && (
          <ErrorBanner message={state.error} dismiss={connection.clearError} />
        )}
        {dependencyError && !showDependencyErrorInline && (
          <ErrorBanner
            message={dependencyError}
            dismiss={() => setDependencyEditGoal(null)}
          />
        )}
        <CommandBar
          command={command}
          live={live}
          replyName={replyTarget?.agent_name ?? replyTarget?.title}
          exitReply={() => {
            setReplyId(undefined);
            command.setDraft("");
            command.setSummary("");
          }}
        />
      </footer>

      {panel === "hidden" && (
        <Panel title="Hidden items" close={closePanel}>
          {hiddenItems.length === 0 ? (
            <p className="empty">No hidden items.</p>
          ) : (
            <ul className="item-list">
              {hiddenItems.map((item) => (
                <li key={item.id}>
                  <button
                    className="text-control"
                    type="button"
                    onClick={() => {
                      selectStreamItem(item.id);
                      closePanel();
                    }}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {panel === "history" && (
        <Panel title="Workspace history" close={closePanel}>
          <StreamHistory
            key={state.resetVersion}
            projects={projects}
            timezone={timezone}
            live={live}
            openIds={openHistoryIds}
            pendingIds={pendingReopens}
            close={closePanel}
            reopen={(item_id, reason) =>
              connection.mutate({
                type: "REOPEN_ITEM",
                input: { item_id, reason },
              })
            }
          />
        </Panel>
      )}
      {panel === "guidance" && state.settings && (
        <Guidance
          settings={state.settings}
          live={live}
          save={connection.save}
          close={closePanel}
        />
      )}
      {panel === "push" && (
        <Panel title="Notifications" close={closePanel}>
          <EnableNotifications
            finish={(message) => {
              command.setSummary(message);
              closePanel();
            }}
          />
        </Panel>
      )}
      {activePanel?.kind === "token-label" && (
        <TokenLabel
          close={closePanel}
          scope={activePanel.scope}
          projectName={activePanel.project?.title ?? "Inbox"}
          create={async (label) => {
            const { scope, project } = activePanel;
            await saveCommand(
              {
                type: "CREATE_TOKEN",
                input: {
                  label,
                  scope,
                  ...(project && { default_project_id: project.id }),
                },
              },
              "",
            );
          }}
        />
      )}
      {activePanel?.kind === "token" && (
        <Panel title="Token created" close={closePanel}>
          <TokenSecret created={activePanel.created} />
        </Panel>
      )}
      {activePanel?.kind === "confirm" && (
        <Panel title={activePanel.title} close={closePanel}>
          <ConfirmCommand
            phrase={activePanel.phrase}
            description={activePanel.description}
            confirm={async () => {
              command.setSummary(
                await saveCommand(activePanel.mutation, activePanel.result),
              );
              closePanel();
            }}
          />
        </Panel>
      )}
      {activePanel?.kind === "list" && (
        <Panel title={activePanel.title} close={closePanel}>
          {activePanel.rows.length ? (
            <ul className="item-list">
              {activePanel.rows.map(({ id, title, detail }) => (
                <li key={id}>
                  <strong>{title}</strong>
                  {detail && <p className="muted">{detail}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing to show.</p>
          )}
        </Panel>
      )}
      {panel === "judge" && (
        <Panel title="Shadow judge" close={closePanel}>
          <ShadowJudgeAgreement revision={state.judgeAgreementRevision} />
        </Panel>
      )}
      {panel === "host" && (
        <Panel title="Settings" close={closePanel}>
          {options?.extraSettingsScreens?.map(
            ({ id, label, component: Screen }) => (
              <section key={id} aria-label={label}>
                <h3>{label}</h3>
                <Screen {...screenProps} />
              </section>
            ),
          )}
        </Panel>
      )}
    </div>
  );
}

export function App({
  registry = lensRegistry,
  options,
  scopeSignal,
  onWorkspaceChange = () => {},
}: {
  registry?: readonly [Lens, ...Lens[]];
  options?: MountAppOptions;
  scopeSignal?: AbortSignal;
  onWorkspaceChange?: () => void;
} = {}) {
  const [session, setSession] = useState<Session>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [expireSession] = useState(() => (devLoginEnabled = false) => {
    setSession((current) =>
      current.status === "signed-in"
        ? { status: "signed-out", devLoginEnabled }
        : current,
    );
  });
  const [reauthenticate] = useState(() => () => {
    setSession({ status: "loading" });
    setAttempt((value) => value + 1);
  });
  const [api] = useState(() => createApi(reauthenticate, scopeSignal));
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const isActive = () => !signal.aborted && !scopeSignal?.aborted;
    async function checkSession() {
      try {
        const response = await fetch("/api/me", { signal });
        if (response.status === 401) {
          const data = await response.json().catch(() => ({}));
          if (isActive())
            setSession({
              status: "signed-out",
              devLoginEnabled: data?.devLoginEnabled === true,
            });
          return;
        }
        if (response.status === 403) {
          const data = await response.json().catch(() => ({}));
          if (!controller.signal.aborted)
            setSession({
              status: "error",
              message:
                data.error?.limit === "connect" &&
                typeof data.error.message === "string"
                  ? data.error.message
                  : undefined,
            });
          return;
        }
        if (!response.ok) throw new Error("Session lookup failed");
        const { email, user, workspaceId, role, capabilities, managed } =
          await response.json();
        const userEmail = user?.email ?? email;
        if (typeof userEmail !== "string" || typeof workspaceId !== "string")
          throw new Error("Invalid session");
        if (isActive())
          setSession({
            status: "signed-in",
            user: {
              id: typeof user?.id === "string" ? user.id : userEmail,
              email: userEmail,
              name: typeof user?.name === "string" ? user.name : null,
            },
            workspaceId,
            role: typeof role === "string" ? role : "owner",
            managed: typeof managed === "boolean" ? managed : undefined,
            capabilities: {
              command: capabilities?.command === true,
              transcription: capabilities?.transcription === true,
            },
          });
      } catch {
        if (isActive()) setSession({ status: "error" });
      }
    }
    void checkSession();
    return () => controller.abort();
  }, [attempt, scopeSignal]);

  if (session.status === "signed-in") {
    return (
      <ApiContext.Provider value={api}>
        <Workspace
          session={session}
          options={options}
          registry={registry}
          onSessionExpired={expireSession}
          onWorkspaceChange={onWorkspaceChange}
        />
      </ApiContext.Provider>
    );
  }

  const SignIn = options?.signIn;
  if (session.status === "signed-out" && SignIn) {
    const { pathname, search, hash } = window.location;
    return <SignIn returnTo={pathname + search + hash} />;
  }

  const item = new URLSearchParams(window.location.search).get("item");
  const signInQuery = item ? `?item=${encodeURIComponent(item)}` : "";
  return (
    <main className="sign-in">
      <div className="sign-in-card">
        <h1>
          <Wordmark />
        </h1>
        {session.status === "loading" && (
          <p role="status">Checking your session…</p>
        )}
        {session.status === "error" && (
          <>
            <p role="alert">
              {session.message ?? "Couldn’t check your session."}
            </p>
            <button type="button" className="primary" onClick={reauthenticate}>
              Try again
            </button>
          </>
        )}
        {session.status === "signed-out" && (
          <>
            <p>Sign in to your workspace.</p>
            <a className="primary" href={`/auth/login${signInQuery}`}>
              Sign in with Google
            </a>
            {session.devLoginEnabled && (
              <a className="dev-login" href={`/auth/dev-login${signInQuery}`}>
                Development sign-in
              </a>
            )}
          </>
        )}
      </div>
    </main>
  );
}
