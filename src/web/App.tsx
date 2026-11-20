import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { StreamRow } from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import { Guidance } from "./Guidance";
import { Inspector } from "./Inspector";
import { QuickAdd } from "./QuickAdd";
import { Settings } from "./Settings";
import {
  lensRegistry,
  readLensId,
  rememberLens,
  resolveLens,
  type Lens,
} from "./lenses";
import { HorizonStream, type LensSelection } from "./horizon-stream";
import { isRadarRowVisible } from "./RadarLens";
import { StreamHistory } from "./stream-history";
import { createWorkspaceConnection } from "./workspace-connection";
import { workspaceView, type MutationInput } from "./workspace-state";
import { selectWorkspace } from "./workspace-view";

type Session =
  | { status: "loading" | "error" }
  | { status: "signed-out"; devLoginEnabled: boolean }
  | { status: "signed-in"; email: string; workspaceId: string };

function Wordmark() {
  return (
    <span className="wordmark">
      <span className="brand-mark" aria-hidden="true" />
      Heed
    </span>
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

function StreamItems({
  rows,
  selectedId,
  select,
}: {
  rows: StreamRow<CanvasItem>[];
  selectedId: string | null;
  select: (id: string) => void;
}) {
  return (
    <ul className="item-list">
      {rows.map(({ item, children }) => (
        <li key={item.id}>
          <button
            type="button"
            className="item-row stream-row"
            aria-pressed={selectedId === item.id}
            onClick={() => select(item.id)}
          >
            <span className="stream-marker" aria-hidden="true" />
            <span className="item-title">{item.title}</span>
          </button>
          {children.length > 0 && (
            <StreamItems
              rows={children}
              selectedId={selectedId}
              select={select}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

const connectionLabels = {
  connecting: "Connecting to workspace…",
  reconnecting: "Reconnecting to workspace…",
  syncing: "Synchronizing workspace…",
};

function Workspace({
  email,
  registry,
  onSessionExpired,
}: {
  email: string;
  registry: readonly [Lens, ...Lens[]];
  onSessionExpired: () => void;
}) {
  const [connection] = useState(createWorkspaceConnection);
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
  );
  const [lensId, setLensId] = useState(readLensId);
  const [selectedId, select] = useState<string | null>(null);
  const [goalId, focusGoal] = useState<string | null>(null);
  const [showGhosts, setShowGhosts] = useState(true);
  const [lensSelection, setLensSelection] = useState<LensSelection | null>(
    null,
  );
  const [history, setHistory] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [panel, setPanel] = useState<{
    kind: "guidance" | "settings" | "goal" | "child";
  } | null>(null);
  const clock = useMinuteClock();
  const view = useMemo(() => workspaceView(state), [state]);
  const derived = useMemo(() => {
    // A broadcast can carry a heartbeat newer than the last clock tick.
    const now = Math.max(clock, Date.now());
    return { ...selectWorkspace(view, now, attentionOnly), now };
  }, [view, clock, attentionOnly]);
  const { projects, tree, filtered, liveCount, timezone, now } = derived;
  const focusedGoal = goalId && filtered.has(goalId) ? goalId : null;
  const lens = resolveLens(
    registry,
    lensId === "dependencies" && !focusedGoal ? null : lensId,
  );
  const LensComponent = lens.component;
  const live = state.connection === "live";
  const selection = selectedId && filtered.has(selectedId) ? selectedId : null;
  const dependenciesLens = registry.find(({ id }) => id === "dependencies");
  const selected = selectedId ? state.items.get(selectedId) : undefined;
  const inspected =
    selected &&
    (hiddenOnly || view.projects.get(selected.project_id)?.hidden === 0)
      ? selected
      : undefined;
  const dependencies = [...view.dependencies.values()];
  const hiddenRows = hiddenOnly
    ? [...view.items.values()]
        .filter((item) => item.parent_id === null && item.hidden === 1)
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((item) => ({ item, children: [] }))
    : [];
  // A save can finish after the same kind of panel has been reopened.
  const closePanel = () =>
    setPanel((current) => (current === panel ? null : current));
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

  const hiddenToggle = (
    <button
      type="button"
      className="project-chip"
      aria-pressed={hiddenOnly}
      onClick={() => {
        setAttentionOnly(false);
        setHiddenOnly((value) => !value);
      }}
    >
      Hidden
    </button>
  );

  useEffect(
    () => connection.start(onSessionExpired),
    [connection, onSessionExpired],
  );

  function updateItem(
    item_id: string,
    patch: Omit<
      Extract<MutationInput, { type: "UPDATE_ITEM" }>["input"],
      "item_id"
    >,
  ) {
    connection.mutate({ type: "UPDATE_ITEM", input: { item_id, ...patch } });
  }

  function switchLens(id: string) {
    setLensId(id);
    if (id !== "dependencies") rememberLens(id);
  }

  function selectStreamItem(id: string) {
    select(id);
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

  return (
    <div className="workspace">
      <header className="workspace-header">
        <Wordmark />
        <div
          className="project-toggles"
          role="group"
          aria-label="Visible projects"
        >
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className="project-chip"
              aria-pressed={!project.hidden}
              disabled={!live}
              onClick={() => {
                const latest = workspaceView(
                  connection.getSnapshot(),
                ).projects.get(project.id);
                if (latest)
                  connection.mutate({
                    type: "UPDATE_PROJECT",
                    project_id: project.id,
                    input: { hidden: latest.hidden ? 0 : 1 },
                  });
              }}
            >
              <span
                className="project-dot"
                style={{ backgroundColor: project.color ?? undefined }}
                aria-hidden="true"
              />
              {project.name}
            </button>
          ))}
        </div>
        <div className="header-tools">
          <label className="lens-select">
            Lens
            <select
              value={lens.id}
              onChange={(event) => switchLens(event.target.value)}
            >
              {registry
                .filter(({ id }) => id !== "dependencies" || focusedGoal)
                .map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          {state.settings && (
            <span className="live-indicator">
              <span data-live={live && liveCount > 0} aria-hidden="true" />
              {liveCount} {liveCount === 1 ? "agent" : "agents"} live
            </span>
          )}
          <button
            type="button"
            className="subtle"
            disabled={!state.settings}
            onClick={() => setPanel({ kind: "guidance" })}
          >
            Guidance
          </button>
          <button
            type="button"
            className="subtle"
            onClick={() => setPanel({ kind: "settings" })}
          >
            Settings
          </button>
        </div>
      </header>

      {state.connection !== "live" && (
        <p className="connection-status" role="status">
          {connectionLabels[state.connection]}
        </p>
      )}
      {state.error && (
        <div className="error-banner">
          <p role="alert">{state.error}</p>
          <button
            type="button"
            className="subtle"
            onClick={connection.clearError}
          >
            Dismiss
          </button>
        </div>
      )}

      <main className="split-layout">
        <section
          className="lens-pane"
          data-lens={lens.id}
          aria-labelledby="lens-heading"
        >
          <div className="section-heading">
            <h1 id="lens-heading">{lens.label}</h1>
            {(lens.id === "radar" || lens.id === "treemap") &&
              state.settings && (
                <details className="lens-menu">
                  <summary className="subtle">Lens options</summary>
                  <label>
                    <input
                      type="checkbox"
                      checked={showGhosts}
                      onChange={(event) => setShowGhosts(event.target.checked)}
                    />
                    Show completed ghosts
                  </label>
                </details>
              )}
            <button
              type="button"
              className="primary"
              disabled={!live}
              onClick={() => setPanel({ kind: "goal" })}
            >
              + Goal
            </button>
          </div>
          {state.settings && (
            <LensComponent
              tree={tree}
              projects={projects}
              items={view.items}
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
                  ? () => switchLens(dependenciesLens.id)
                  : undefined
              }
              select={(id) => {
                if (lens.id === "list" && id) selectStreamItem(id);
                else select(id);
                setLensSelection(
                  id ? { id, scrollStreamOnly: lens.id === "treemap" } : null,
                );
                if (id) setHistory(false);
              }}
              reschedule={(id, date) => updateItem(id, { scheduled_on: date })}
              moveProject={(id, project) => updateItem(id, { project })}
              setPriority={(id, priority) => updateItem(id, { priority })}
              setPosition={(id, position) => placeItem(id, lens.id, position)}
              moveRadar={(id, { position, ...patch }, key = "radar") =>
                placeItem(id, key, position, patch)
              }
            />
          )}
          {inspected && (
            <Inspector
              key={inspected.id}
              item={inspected}
              projects={projects}
              items={state.items}
              dependencies={dependencies}
              timezone={timezone}
              live={live}
              save={connection.save}
              close={() =>
                select((current) => (current === inspected.id ? null : current))
              }
              addChild={() => setPanel({ kind: "child" })}
            />
          )}
        </section>
        <section className="stream-pane" aria-labelledby="stream-heading">
          <div className="sheet-handle" aria-hidden="true" />
          {history ? (
            <StreamHistory
              projects={projects}
              timezone={timezone}
              live={live}
              openIds={openHistoryIds}
              pendingIds={pendingReopens}
              close={() => setHistory(false)}
              reopen={(item_id, reason) =>
                connection.mutate({
                  type: "REOPEN_ITEM",
                  input: { item_id, reason },
                })
              }
            />
          ) : hiddenOnly ? (
            <>
              <div className="section-heading stream-heading">
                <h2 id="stream-heading">Horizon Stream</h2>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="attention-button"
                    aria-pressed={false}
                    onClick={() => {
                      setHiddenOnly(false);
                      setAttentionOnly(true);
                    }}
                  >
                    Needs me <span>{derived.attentionCount}</span>
                  </button>
                  {hiddenToggle}
                </div>
              </div>
              <div className="stream-content">
                {hiddenRows.length ? (
                  <StreamItems
                    rows={hiddenRows}
                    selectedId={selectedId}
                    select={(id) => {
                      setLensSelection(null);
                      select(id);
                    }}
                  />
                ) : (
                  <p className="empty">No hidden items.</p>
                )}
              </div>
            </>
          ) : (
            <HorizonStream
              {...derived}
              items={view.items}
              dependencies={view.dependencies}
              ready={state.settings !== null}
              live={live}
              attentionOnly={attentionOnly}
              toggleAttention={() => setAttentionOnly((value) => !value)}
              actions={hiddenToggle}
              selectedId={selectedId}
              lensSelection={lensSelection}
              select={(id) => {
                setLensSelection(null);
                selectStreamItem(id);
              }}
              move={connection.mutate}
              showHistory={() => setHistory(true)}
            />
          )}
        </section>
      </main>
      {panel?.kind === "guidance" && state.settings && (
        <Guidance
          settings={state.settings}
          live={live}
          save={connection.save}
          close={closePanel}
        />
      )}
      {panel?.kind === "settings" && (
        <Settings
          projects={projects}
          items={state.items}
          timezone={timezone}
          email={email}
          live={live}
          save={connection.save}
          close={closePanel}
        />
      )}
      {(panel?.kind === "goal" || panel?.kind === "child") && (
        <QuickAdd
          parent={panel.kind === "child" ? inspected : undefined}
          parentMissing={panel.kind === "child" && !inspected}
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
}: { registry?: readonly [Lens, ...Lens[]] } = {}) {
  const [session, setSession] = useState<Session>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Changing the attempt restarts the gate when the connection detects an expired session.
  const [reauthenticate] = useState(() => () => {
    setSession({ status: "loading" });
    setAttempt((value) => value + 1);
  });
  useEffect(() => {
    const controller = new AbortController();
    async function checkSession() {
      try {
        const response = await fetch("/api/me", { signal: controller.signal });
        if (response.status === 401) {
          const data = await response.json().catch(() => ({}));
          if (!controller.signal.aborted)
            setSession({
              status: "signed-out",
              devLoginEnabled: data.devLoginEnabled === true,
            });
          return;
        }
        if (!response.ok) throw new Error("Session lookup failed");
        const { email, workspaceId } = await response.json();
        if (typeof email !== "string" || typeof workspaceId !== "string")
          throw new Error("Invalid session");
        if (!controller.signal.aborted)
          setSession({ status: "signed-in", email, workspaceId });
      } catch {
        if (!controller.signal.aborted) setSession({ status: "error" });
      }
    }
    void checkSession();
    return () => controller.abort();
  }, [attempt]);

  if (session.status === "signed-in") {
    return (
      <Workspace
        key={session.workspaceId}
        email={session.email}
        registry={registry}
        onSessionExpired={reauthenticate}
      />
    );
  }

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
            <p role="alert">Couldn’t check your session.</p>
            <button type="button" className="primary" onClick={reauthenticate}>
              Try again
            </button>
          </>
        )}
        {session.status === "signed-out" && (
          <>
            <p>Sign in to your workspace.</p>
            <a className="primary" href="/auth/login">
              Sign in with Google
            </a>
            {session.devLoginEnabled && (
              <a className="dev-login" href="/auth/dev-login">
                Development sign-in
              </a>
            )}
          </>
        )}
      </div>
    </main>
  );
}
