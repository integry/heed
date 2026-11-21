import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import type { CommandCapabilities } from "@heedwork/core";
import {
  CommandBar,
  Microphone,
  ModelKeyHint,
  useCommandBar,
} from "./CommandBar";
import { DemoBadge } from "./item-markers";
import { Panel } from "./workspace-controls";
import type { StreamRow } from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import type { Dependency, Item } from "@heedwork/core";
import { isDescendant } from "./dependency-graph";
import {
  GuideEmpty,
  OnboardingGuide,
  onboardingCompletion,
  type OnboardingScreen,
} from "./Onboarding";
import { usePushEnabled } from "./PushSettings";
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
import { useAction } from "./workspace-controls";
import { ApiContext, createApi, useApi, useResource } from "./api";
import type { AppUser, MountAppOptions } from "./web-options";
import { workspaceView, type MutationInput } from "./workspace-state";
import { selectWorkspace } from "./workspace-view";

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
            {item.demo === 1 && <DemoBadge />}
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
  const [lensId, setLensId] = useState(readLensId);
  const [selectedItem, setSelectedItem] = useState<{
    id: string;
    inspectorOpen: boolean;
    fromNotification?: boolean;
  } | null>(() => {
    const id = new URLSearchParams(window.location.search).get("item");
    return id ? { id, inspectorOpen: true, fromNotification: true } : null;
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
  // Dependency saves can outlive the graph that submitted them.
  const [dependencyEditGoal, setDependencyEditGoal] = useState<string | null>(
    null,
  );
  const dependencyEdit = useAction();
  const [showGhosts, setShowGhosts] = useState(true);
  const [lensSelection, setLensSelection] = useState<LensSelection | null>(
    null,
  );
  const [history, setHistory] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [panel, setPanel] = useState<{
    kind: "guidance" | "settings" | "goal" | "child" | "command" | "onboarding";
    fromGuide?: boolean;
    screen?: OnboardingScreen;
  } | null>(null);
  const clock = useMinuteClock();
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop);
  const command = useCommandBar(
    connection.save,
    capabilities.transcription,
    capabilities.command && (desktop || panel?.kind === "command"),
  );
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
  const lens = resolveLens(registry, lensId);
  const LensComponent = lens.component;
  const canvasLens = lens.id === "radar" || lens.id === "treemap";
  const live = state.connection === "live";
  const autoGuide =
    state.onboarding?.hasItems === false &&
    !state.settings?.onboarding_dismissed;
  const guideVisible = panel?.kind === "onboarding" || (autoGuide && !panel);
  const notificationsEnabled = usePushEnabled(
    guideVisible && options?.hideScreens?.includes("notifications") !== true,
  );
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
    : selected &&
        (hiddenOnly || view.projects.get(selected.project_id)?.hidden === 0)
      ? selected
      : undefined;
  // Desktop opens the inspector for a selection made on the mobile canvas.
  // Carry that open state back to mobile if the viewport narrows again.
  if (desktop && inspected && selectedItem && !selectedItem.inspectorOpen) {
    setSelectedItem({ ...selectedItem, inspectorOpen: true });
  }
  const dependencies = useMemo(
    () => [...view.dependencies.values()],
    [view.dependencies],
  );
  const inspectedGoal = inspected ? dependencyGoal(inspected.id) : null;
  const hiddenRows = hiddenOnly
    ? [...view.items.values()]
        .filter((item) => item.parent_id === null && item.hidden === 1)
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((item) => ({ item, children: [] }))
    : [];
  // A save can finish after the same kind of panel has been reopened.
  const closePanel = () =>
    setPanel((current) =>
      current === panel
        ? panel?.fromGuide
          ? { kind: "onboarding" }
          : null
        : current,
    );
  const openGuide = state.onboarding
    ? () => setPanel({ kind: "onboarding" })
    : undefined;
  const guide = state.onboarding && state.settings && (
    <OnboardingGuide
      completion={onboardingCompletion(
        state.onboarding,
        state.settings.guidance,
        notificationsEnabled,
      )}
      loaded={state.onboarding.hasDemoData}
      live={live}
      save={connection.save}
      hidden={options?.hideScreens}
      openGoal={() => setPanel({ kind: "goal", fromGuide: true })}
      openSettings={(screen) =>
        setPanel({ kind: "settings", screen, fromGuide: true })
      }
      openGuidance={() => setPanel({ kind: "guidance", fromGuide: true })}
      onDismiss={!state.settings.onboarding_dismissed ? closePanel : undefined}
      onDemoLoad={closePanel}
    />
  );
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
    rememberLens(id);
    if (id === "dependencies" && !desktop && sheet.stop === "full") {
      sheet.changeStop("peek");
    }
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

  function inspectItem(id: string) {
    setSelectedItem({ id, inspectorOpen: true });
  }

  function selectStreamItem(id: string) {
    inspectItem(id);
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
          {project.demo === 1 && <DemoBadge />}
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

  const inspector = inspected && selectedItem?.inspectorOpen && (
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
              ? { id: inspected.id, inspectorOpen: false }
              : null,
        );
      }}
      addChild={() => setPanel({ kind: "child" })}
      openDependencies={
        dependenciesLens &&
        inspectedGoal &&
        (lens.id !== dependenciesLens.id || focusedGoal !== inspectedGoal)
          ? () => {
              if (!desktop) {
                setSelectedItem({ id: inspected.id, inspectorOpen: false });
              }
              focusGoal(inspectedGoal);
              switchLens(dependenciesLens.id);
            }
          : undefined
      }
      selectChild={lens.id === "board" ? selectStreamItem : undefined}
    />
  );

  return (
    <div className="workspace" data-layout={desktop ? "desktop" : "mobile"}>
      <header className="workspace-header">
        {HeaderStart && <HeaderStart {...slotProps} />}
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
                .filter(
                  ({ id }) =>
                    id !== "dependencies" || focusedGoal || lens.id === id,
                )
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
          {HeaderEnd && <HeaderEnd {...slotProps} />}
        </div>
      </header>

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
          {autoGuide && panel?.kind !== "onboarding" ? (
            <section
              className="onboarding-welcome"
              aria-labelledby="onboarding-heading"
            >
              <h2 id="onboarding-heading">Set up your workspace</h2>
              {guide}
            </section>
          ) : (
            state.settings && (
              <LensComponent
                openGuide={openGuide}
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
                    ? () => switchLens(dependenciesLens.id)
                    : undefined
                }
                select={(id) => {
                  if (lens.id === "list" && id) selectStreamItem(id);
                  else
                    setSelectedItem(
                      id ? { id, inspectorOpen: desktop || !canvasLens } : null,
                    );
                  setLensSelection(
                    id ? { id, scrollStreamOnly: lens.id === "treemap" } : null,
                  );
                  if (id) setHistory(false);
                }}
                move={connection.mutate}
                reschedule={(id, date) =>
                  updateItem(id, { scheduled_on: date })
                }
                moveProject={(id, project) => updateItem(id, { project })}
                setPriority={(id, priority) => updateItem(id, { priority })}
                setPosition={(id, position) => placeItem(id, lens.id, position)}
                moveRadar={(id, { position, ...patch }, key = "radar") =>
                  placeItem(id, key, position, patch)
                }
              />
            )
          )}
          {dependencyError && showDependencyErrorInline && (
            <p className="action-error" role="alert">
              {dependencyError}
            </p>
          )}
          {inspector}
          {desktop && capabilities.command && (
            <CommandBar command={command} live={live} />
          )}
          {showModelKeyHint && (
            <div className="command-bar">
              <ModelKeyHint />
            </div>
          )}
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
              openGuide={openGuide}
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
                key={state.resetVersion}
                demoLoaded={state.onboarding?.hasDemoData}
                openGuide={openGuide}
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
                    <GuideEmpty openGuide={openGuide}>
                      No hidden items.
                    </GuideEmpty>
                  )}
                </div>
              </>
            ) : (
              <HorizonStream
                {...derived}
                openGuide={openGuide}
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
          {capabilities.command && (
            <button
              type="button"
              className="primary command-button"
              aria-label="Open command bar"
              aria-haspopup="dialog"
              disabled={!live}
              onClick={() => setPanel({ kind: "command" })}
            >
              <Microphone />
            </button>
          )}
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
      {!desktop && panel?.kind === "command" && capabilities.command && (
        <Panel
          title="Workspace command"
          close={closePanel}
          className="command-panel"
        >
          <CommandBar command={command} live={live} />
          <button
            type="button"
            className="subtle command-guidance"
            onClick={() => setPanel({ kind: "guidance" })}
          >
            Edit guidance
          </button>
        </Panel>
      )}
      {panel?.kind === "onboarding" && guide && (
        <Panel
          title="Set up your workspace"
          className="onboarding-panel"
          close={closePanel}
        >
          {guide}
        </Panel>
      )}
      {panel?.kind === "guidance" && state.settings && (
        <Guidance
          showExamples={panel.fromGuide}
          settings={state.settings}
          live={live}
          save={connection.save}
          close={closePanel}
        />
      )}
      {panel?.kind === "settings" && (
        <Settings
          focus={panel.screen}
          openGuide={openGuide}
          demoLoaded={state.onboarding?.hasDemoData ?? false}
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
