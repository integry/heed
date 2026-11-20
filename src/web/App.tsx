import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  STREAM_BANDS,
  type Band,
  type StreamRow,
} from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import { GuidanceTextSchema, MAX_GUIDANCE_LENGTH } from "../shared/workspace";
import {
  lensRegistry,
  readLensId,
  rememberLens,
  resolveLens,
  type Lens,
} from "./lenses";
import { createWorkspaceConnection } from "./workspace-connection";
import { workspaceView, type MutationInput } from "./workspace-state";
import { selectWorkspace } from "./workspace-view";

const bandLabels: Record<Band, string> = {
  "done-today": "Done today",
  today: "Today",
  tomorrow: "Tomorrow",
  "this-week": "This week",
  later: "Later",
  backlog: "Backlog",
};

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

function WorkspaceDialog({
  panel,
  close,
  guidance,
  timezone,
  email,
  save,
  live,
}: {
  panel: "guidance" | "settings";
  close: () => void;
  guidance: string;
  timezone: string;
  email: string;
  save: (text: string) => boolean;
  live: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(guidance);
  const valid = GuidanceTextSchema.safeParse(draft).success;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} onClose={close} aria-labelledby="panel-title">
      <div className="panel-heading">
        <h2 id="panel-title">
          {panel === "guidance" ? "Guidance" : "Settings"}
        </h2>
        <button
          type="button"
          className="subtle"
          onClick={() => dialog.current?.close()}
        >
          Close
        </button>
      </div>
      {panel === "guidance" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && save(draft)) dialog.current?.close();
          }}
        >
          <label htmlFor="guidance-text">Instructions for your agents</label>
          <textarea
            id="guidance-text"
            rows={6}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="dialog-actions">
            <small>
              {[...draft].length} / {MAX_GUIDANCE_LENGTH}
            </small>
            <button className="primary" disabled={!live || !valid}>
              Save guidance
            </button>
          </div>
        </form>
      ) : (
        <>
          <dl className="settings-details">
            <dt>Signed in as</dt>
            <dd>{email}</dd>
            <dt>Workspace timezone</dt>
            <dd>{timezone}</dd>
          </dl>
          <form action="/auth/logout" method="post">
            <button className="subtle">Sign out</button>
          </form>
        </>
      )}
    </dialog>
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
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [panel, setPanel] = useState<"guidance" | "settings" | null>(null);
  const clock = useMinuteClock();
  const view = useMemo(() => workspaceView(state), [state]);
  const {
    projects,
    tree,
    filtered,
    bands,
    attentionCount,
    liveCount,
    timezone,
    now,
  } = useMemo(() => {
    // A broadcast can carry a heartbeat newer than the last clock tick.
    const now = Math.max(clock, Date.now());
    return { ...selectWorkspace(view, now, attentionOnly), now };
  }, [view, clock, attentionOnly]);
  const lens = resolveLens(registry, lensId);
  const LensComponent = lens.component;
  const live = state.connection === "live";
  const selection = selectedId && filtered.has(selectedId) ? selectedId : null;
  const hasStreamRows = STREAM_BANDS.some((band) => bands[band].length > 0);

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
              onChange={(event) => {
                setLensId(event.target.value);
                rememberLens(event.target.value);
              }}
            >
              {registry.map(({ id, label }) => (
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
            onClick={() => setPanel("guidance")}
          >
            Guidance
          </button>
          <button
            type="button"
            className="subtle"
            onClick={() => setPanel("settings")}
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
        <section className="lens-pane" aria-labelledby="lens-heading">
          <div className="section-heading">
            <h1 id="lens-heading">{lens.label}</h1>
          </div>
          {state.settings && (
            <LensComponent
              tree={tree}
              projects={projects}
              items={view.items}
              dependencies={[...view.dependencies.values()]}
              selectedId={selection}
              now={now}
              select={select}
              reschedule={(id, date) => updateItem(id, { scheduled_on: date })}
              moveProject={(id, project) => updateItem(id, { project })}
              setPriority={(id, priority) => updateItem(id, { priority })}
              setPosition={(id, position) => {
                const item = workspaceView(connection.getSnapshot()).items.get(
                  id,
                );
                if (!item) return;
                const positions = JSON.parse(item.layout_pos) as Record<
                  string,
                  Record<string, number>
                >;
                updateItem(id, {
                  layout_pos: { ...positions, [lens.id]: position },
                });
              }}
            />
          )}
        </section>
        <section className="stream-pane" aria-labelledby="stream-heading">
          <div className="sheet-handle" aria-hidden="true" />
          <div className="section-heading stream-heading">
            <h2 id="stream-heading">Horizon Stream</h2>
            <button
              type="button"
              className="attention-button"
              aria-pressed={attentionOnly}
              onClick={() => setAttentionOnly((value) => !value)}
            >
              Needs me <span>{attentionCount}</span>
            </button>
          </div>
          <div className="stream-content">
            {state.settings && !hasStreamRows && (
              <p className="empty">
                {attentionOnly
                  ? "Nothing needs your input."
                  : "No items in the stream."}
              </p>
            )}
            {STREAM_BANDS.filter((band) => bands[band].length > 0).map(
              (band) => (
                <section className="stream-band" key={band}>
                  <h3>{bandLabels[band]}</h3>
                  <StreamItems
                    rows={bands[band]}
                    selectedId={selectedId}
                    select={select}
                  />
                </section>
              ),
            )}
          </div>
        </section>
      </main>
      {panel && (
        <WorkspaceDialog
          key={panel}
          panel={panel}
          close={() => setPanel(null)}
          guidance={view.settings?.guidance ?? ""}
          timezone={timezone}
          email={email}
          live={live}
          save={(text) =>
            connection.mutate({ type: "SET_GUIDANCE", input: { text } })
          }
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
