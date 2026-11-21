import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CommandCapabilities, Dependency, Item } from "@heedwork/core";
import { CommandBar, useCommandBar } from "./CommandBar";
import { AttentionStream } from "./AttentionStream";
import { SelectedItem } from "./SelectedItem";
import { isDescendant } from "./dependency-graph";
import { Guidance } from "./Guidance";
import { Inspector } from "./Inspector";
import { QuickAdd } from "./QuickAdd";
import { Settings } from "./Settings";
import { lensRegistry, resolveLens, type Lens } from "./lenses";
import { isRadarRowVisible } from "./RadarLens";
import { StreamHistory } from "./stream-history";
import { createWorkspaceConnection } from "./workspace-connection";
import { Panel, useAction } from "./workspace-controls";
import { ApiContext, createApi, useApi, useResource } from "./api";
import type { AppUser, MountAppOptions } from "./web-options";
import { workspaceView, type MutationInput } from "./workspace-state";
import { selectWorkspace } from "./workspace-view";

type PanelKind =
  | "guidance"
  | "settings"
  | "goal"
  | "child"
  | "history"
  | "hidden"
  | "inspector";

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
  const { getJson, postJson } = useApi();
  const api = useMemo(
    () => ({ getJson, postJson, useResource }),
    [getJson, postJson],
  );
  const screenProps = { user, workspaceId, role, api };
  const slotProps = { ...screenProps, onWorkspaceChange };
  const HeaderStart = options?.headerStart;
  const HeaderEnd = options?.headerEnd;
  const showModelKeyHint = managed === false && !capabilities.command;
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
  const [activePanel, setActivePanel] = useState<{ kind: PanelKind } | null>(
    null,
  );
  const panel = activePanel?.kind;
  function openPanel(kind: PanelKind) {
    setActivePanel({ kind });
  }
  const clock = useMinuteClock();
  const command = useCommandBar(
    connection.save,
    capabilities.transcription,
    capabilities.command,
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
  const inspected = selectedItem?.fromNotification
    ? (selected ?? fallback)
    : selected && (panel === "inspector" || derived.visibleIds.has(selected.id))
      ? selected
      : undefined;
  useEffect(() => {
    if (panel === "inspector" && !inspected) setActivePanel(null);
  }, [panel, inspected]);
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
          closePanel();
          focusGoal(inspectedGoal);
          setLensId(dependenciesLens.id);
        }
      : undefined;

  return (
    <div className="attention-app">
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
            <button
              className="text-control"
              type="button"
              onClick={() => openPanel("goal")}
              disabled={!live}
            >
              Add item
            </button>
            <button
              className="text-control"
              type="button"
              onClick={() => openPanel("history")}
            >
              History
            </button>
            <button
              className="text-control"
              type="button"
              onClick={() => openPanel("hidden")}
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
              onClick={() => openPanel("guidance")}
              disabled={!state.settings}
            >
              Guidance
            </button>
            <button
              className="text-control"
              type="button"
              onClick={() => openPanel("settings")}
            >
              Settings
            </button>
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
                  setSelectedItem(id ? { id } : null);
                  setRadarSelection(id);
                }
              }}
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
          {inspected && (
            <SelectedItem
              key={inspected.id}
              item={inspected}
              revision={eventRevision(inspected.id)}
              inspect={() => openPanel("inspector")}
              close={() => {
                setSelectedItem(null);
                setRadarSelection(null);
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
          enabled={capabilities.command}
        />
      </footer>

      {panel === "inspector" && inspected && (
        <Inspector
          key={inspected.id}
          activityRevision={eventRevision(inspected.id)}
          drawer
          item={inspected}
          projects={projects}
          items={state.items}
          dependencies={dependencies}
          timezone={timezone}
          live={live}
          save={connection.save}
          close={closePanel}
          addChild={() => openPanel("child")}
          openDependencies={openGraph}
          selectChild={
            lens.id === "board"
              ? (id) => {
                  selectStreamItem(id);
                  closePanel();
                }
              : undefined
          }
        />
      )}
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
                      setSelectedItem({ id: item.id });
                      openPanel("inspector");
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
      {panel === "settings" && (
        <Settings
          judgeAgreementRevision={state.judgeAgreementRevision}
          projects={projects}
          items={state.items}
          timezone={timezone}
          screenProps={screenProps}
          options={options}
          showModelKeyHint={showModelKeyHint}
          resetVersion={state.resetVersion}
          onSignOut={
            signOut &&
            (async () => {
              await signOut();
              onSessionExpired();
            })
          }
          live={live}
          save={connection.save}
          close={closePanel}
        />
      )}
      {(panel === "goal" || panel === "child") && (
        <QuickAdd
          parent={panel === "child" ? inspected : undefined}
          parentMissing={panel === "child" && !inspected}
          projects={projects}
          timezone={timezone}
          live={live}
          save={connection.save}
          close={closePanel}
        />
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
