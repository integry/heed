import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
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
import { useMobileSheet } from "./mobile-sheet";
import { StreamPeek } from "./StreamPeek";
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

const desktopQuery = "(min-width: 768px)";

function subscribeDesktop(listener: () => void) {
  const media = window.matchMedia?.(desktopQuery);
  media?.addEventListener("change", listener);
  return () => media?.removeEventListener("change", listener);
}

function isDesktop() {
  return window.matchMedia?.(desktopQuery).matches ?? true;
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
  const [selectedItem, setSelectedItem] = useState<{
    id: string;
    openDrawer: boolean;
  } | null>(null);
  const selectedId = selectedItem?.id ?? null;
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
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop);
  const sheet = useMobileSheet(desktop, (next) => {
    if (next !== "full") {
      setHistory(false);
      setHiddenOnly(false);
    }
  });
  const peek = !desktop && sheet.stop === "peek";
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
  const canvasLens = lens.id === "radar" || lens.id === "treemap";
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
        if (!desktop) sheet.changeStop("full");
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

  function inspectItem(id: string) {
    setSelectedItem({ id, openDrawer: true });
  }

  function selectStreamItem(id: string) {
    inspectItem(id);
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

  const projectToggles = (
    <div className="project-toggles" role="group" aria-label="Visible projects">
      {projects.map((project) => (
        <button
          type="button"
          key={project.id}
          className="project-chip"
          aria-pressed={!project.hidden}
          disabled={!live}
          onClick={() => {
            const latest = workspaceView(connection.getSnapshot()).projects.get(
              project.id,
            );
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
  );
  const settingsActions = (
    <>
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
    </>
  );
  const ghostsToggle = (lens.id === "radar" ||
    lens.id === "board" ||
    lens.id === "treemap") &&
    state.settings && (
      <label>
        <input
          type="checkbox"
          checked={showGhosts}
          onChange={(event) => setShowGhosts(event.target.checked)}
        />
        Show completed ghosts
      </label>
    );

  const inspector = inspected && (desktop || selectedItem?.openDrawer) && (
    <Inspector
      key={inspected.id}
      drawer={!desktop}
      item={inspected}
      projects={projects}
      items={state.items}
      dependencies={dependencies}
      timezone={timezone}
      live={live}
      save={connection.save}
      close={() => {
        // A delete can finish after this inspection has been dismissed.
        setSelectedItem((current) =>
          current !== selectedItem
            ? current
            : !desktop && canvasLens
              ? { id: inspected.id, openDrawer: false }
              : null,
        );
      }}
      addChild={() => setPanel({ kind: "child" })}
      selectChild={lens.id === "board" ? selectStreamItem : undefined}
    />
  );

  return (
    <div className="workspace" data-layout={desktop ? "desktop" : "mobile"}>
      <header className="workspace-header">
        <Wordmark />
        {desktop ? (
          projectToggles
        ) : (
          <details className="header-menu project-menu" name="workspace-menu">
            <summary className="subtle">Projects</summary>
            {projectToggles}
          </details>
        )}
        <div className="header-tools">
          <label className="lens-select">
            {!desktop ? <span className="sr-only">Lens</span> : "Lens"}
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
              {liveCount} {desktop && (liveCount === 1 ? "agent " : "agents ")}
              live
            </span>
          )}
          {desktop ? (
            settingsActions
          ) : (
            <details
              className="header-menu workspace-menu"
              name="workspace-menu"
            >
              <summary className="subtle" aria-label="Workspace menu">
                ⋯
              </summary>
              <div className="workspace-menu-actions">
                {ghostsToggle}
                {settingsActions}
              </div>
            </details>
          )}
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

      <main
        className="split-layout"
        ref={sheet.layout}
        data-sheet-stop={desktop ? undefined : sheet.stop}
        data-sheet-dragging={!desktop && sheet.height !== undefined}
        style={
          !desktop && sheet.height !== undefined
            ? ({ "--sheet-drag-height": `${sheet.height}px` } as CSSProperties)
            : undefined
        }
      >
        <section
          className="lens-pane"
          data-lens={lens.id}
          aria-labelledby="lens-heading"
          inert={!desktop && sheet.stop === "full"}
        >
          <div className="section-heading">
            <h1 id="lens-heading">{lens.label}</h1>
            {desktop && ghostsToggle && (
              <details className="lens-menu">
                <summary className="subtle">Lens options</summary>
                {ghostsToggle}
              </details>
            )}
            {desktop && (
              <button
                type="button"
                className="primary"
                disabled={!live}
                onClick={() => setPanel({ kind: "goal" })}
              >
                + Goal
              </button>
            )}
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
                else
                  setSelectedItem(id ? { id, openDrawer: !canvasLens } : null);
                setLensSelection(
                  id ? { id, scrollStreamOnly: lens.id === "treemap" } : null,
                );
                if (id) setHistory(false);
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
          )}
          {desktop && inspector}
        </section>
        <section
          className="stream-pane"
          id="mobile-stream"
          ref={sheet.pane}
          aria-label={peek ? "Horizon Stream" : undefined}
          aria-labelledby={peek ? undefined : "stream-heading"}
        >
          {!desktop && sheet.handle}
          {peek && (
            <StreamPeek
              {...derived}
              items={view.items}
              ready={state.settings !== null}
              selectedId={selectedId}
              select={(id) => {
                setLensSelection(null);
                selectStreamItem(id);
              }}
            />
          )}
          <div className="stream-panel" hidden={peek}>
            {history && (desktop || sheet.stop === "full") ? (
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
            ) : hiddenOnly && (desktop || sheet.stop === "full") ? (
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
                        inspectItem(id);
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
                condensed={lens.id === "board" && desktop}
                todayOnly={!desktop && sheet.stop === "half"}
                toggleAttention={() => setAttentionOnly((value) => !value)}
                actions={hiddenToggle}
                selectedId={selectedId}
                lensSelection={lensSelection}
                select={(id) => {
                  setLensSelection(null);
                  selectStreamItem(id);
                }}
                move={connection.mutate}
                showHistory={() => {
                  setHistory(true);
                  if (!desktop) sheet.changeStop("full");
                }}
              />
            )}
          </div>
        </section>
        {!desktop && inspector}
      </main>
      {!desktop && (
        <nav className="mobile-dock" aria-label="Workspace shortcuts">
          <button
            type="button"
            className="subtle"
            disabled={!live}
            onClick={() => setPanel({ kind: "goal" })}
          >
            + Goal
          </button>
          <button
            type="button"
            className="primary command-button"
            aria-label="Open quick add"
            disabled={!live}
            onClick={() => setPanel({ kind: "goal" })}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            >
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6" />
            </svg>
          </button>
          <button
            type="button"
            className="subtle"
            aria-controls="mobile-stream"
            onClick={sheet.toggleList}
          >
            {sheet.stop === "full" ? "Lens" : "List"}
          </button>
          {canvasLens && inspected && selection && sheet.stop !== "full" && (
            <button
              type="button"
              className="subtle inspect-selection"
              aria-label={`Inspect ${inspected.title}`}
              aria-haspopup="dialog"
              onClick={() => inspectItem(inspected.id)}
            >
              Inspect
            </button>
          )}
        </nav>
      )}
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
