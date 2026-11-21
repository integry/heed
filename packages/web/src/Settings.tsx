import { useEffect, useId, useRef, useState } from "react";
import {
  INBOX_PROJECT_ID,
  RESET_WORKSPACE_CONFIRMATION,
  ScopeSchema,
  TimezoneSchema,
} from "@heedwork/core";
import type { Item, Project, Scope, TokenMetadata } from "@heedwork/core";
import type { CreatedToken } from "@heedwork/core";
import { Panel, ProjectOptions, useAction } from "./workspace-controls";
import type { SaveMutation } from "./workspace-controls";
import { DemoDataButton, type OnboardingScreen } from "./Onboarding";
import { PushSettings } from "./PushSettings";
import { ModelKeyHint } from "./CommandBar";
import { useApi } from "./api";
import { DemoBadge } from "./item-markers";
import type {
  BuiltInScreenId,
  MountAppOptions,
  SettingsScreen,
  SettingsScreenProps,
} from "./web-options";

type SettingsActions = { live: boolean; save: SaveMutation };

function ProjectRow({
  project,
  hasItems,
  canMoveUp,
  canMoveDown,
  live,
  save,
}: SettingsActions & {
  project: Project;
  hasItems: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const [name, setName] = useState<string>();
  const [color, setColor] = useState<string>();
  const { busy, error, run } = useAction();
  const inbox = project.id === INBOX_PROJECT_ID;
  const disabled = !live || busy;
  const project_id = project.id;
  const nextName = (name ?? project.name).trim();
  const nextColor = (color ?? project.color ?? "").trim() || null;
  const changed = nextName !== project.name || nextColor !== project.color;
  function update(input: Partial<Omit<Project, "id">>) {
    return save({ type: "UPDATE_PROJECT", project_id, input });
  }

  return (
    <li className="settings-row">
      <div className="project-row-heading">
        <span
          className="project-dot"
          style={{ backgroundColor: project.color ?? undefined }}
          aria-hidden="true"
        />
        <h4>{project.name}</h4>
        {project.demo === 1 && <DemoBadge />}
        {inbox && <small className="muted">Default project</small>}
        {project.hidden === 1 && <small className="muted">Hidden</small>}
      </div>
      {!inbox && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!nextName || !changed) return;
            void run(async () => {
              await update({
                ...(nextName !== project.name ? { name: nextName } : {}),
                ...(nextColor !== project.color ? { color: nextColor } : {}),
              });
              setName(undefined);
              setColor(undefined);
            });
          }}
        >
          <fieldset className="project-edit" disabled={disabled}>
            <label className="form-field">
              Project name
              <input
                required
                value={name ?? project.name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="form-field">
              Colour
              <input
                type="color"
                value={
                  /^#[0-9a-f]{6}$/i.test(nextColor ?? "")
                    ? nextColor!
                    : "#527961"
                }
                onChange={(event) => setColor(event.target.value)}
              />
            </label>
            {nextColor && (
              <button
                type="button"
                className="subtle"
                onClick={() => setColor("")}
              >
                Reset colour
              </button>
            )}
            {changed && (
              <button className="subtle" disabled={!nextName}>
                Save project
              </button>
            )}
          </fieldset>
        </form>
      )}
      <div className="inline-actions">
        <button
          type="button"
          className="subtle"
          disabled={disabled}
          onClick={() =>
            void run(() => update({ hidden: project.hidden ? 0 : 1 }))
          }
        >
          {project.hidden ? "Unhide" : "Hide"}
        </button>
        {!inbox && (
          <>
            <button
              type="button"
              className="subtle"
              disabled={disabled || !canMoveUp}
              onClick={() =>
                void run(() =>
                  save({
                    type: "MOVE_PROJECT",
                    input: { project_id, direction: "up" },
                  }),
                )
              }
            >
              Move up
            </button>
            <button
              type="button"
              className="subtle"
              disabled={disabled || !canMoveDown}
              onClick={() =>
                void run(() =>
                  save({
                    type: "MOVE_PROJECT",
                    input: { project_id, direction: "down" },
                  }),
                )
              }
            >
              Move down
            </button>
            <button
              type="button"
              className="subtle danger"
              disabled={disabled || hasItems}
              title={
                hasItems
                  ? "Move or delete its items before deleting this project."
                  : undefined
              }
              onClick={() => {
                if (window.confirm(`Delete the project “${project.name}”?`))
                  void run(() =>
                    save({ type: "DELETE_PROJECT", input: { project_id } }),
                  );
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

function Projects({
  projects,
  items,
  live,
  save,
}: SettingsActions & {
  projects: readonly Project[];
  items: ReadonlyMap<string, Item>;
}) {
  const { busy, error, run } = useAction();
  const movable = projects.filter(({ id }) => id !== INBOX_PROJECT_ID);
  const populated = new Set(
    [...items.values()].map(({ project_id }) => project_id),
  );
  return (
    <section className="settings-section" aria-labelledby="projects-heading">
      <h3 id="projects-heading">Projects</h3>
      <ul className="settings-list">
        {projects.map((project) => {
          const position = movable.indexOf(project);
          return (
            <ProjectRow
              key={project.id}
              project={project}
              hasItems={populated.has(project.id)}
              canMoveUp={position > 0}
              canMoveDown={position < movable.length - 1}
              live={live}
              save={save}
            />
          );
        })}
      </ul>
      <form
        className="inline-actions settings-add"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const name = String(new FormData(form).get("name")).trim();
          if (!name) return;
          void run(async () => {
            const sort = Math.max(0, ...projects.map(({ sort }) => sort)) + 1;
            await save(
              { type: "CREATE_PROJECT", input: { name, sort } },
              { callerReportsError: true },
            );
            form.reset();
          });
        }}
      >
        <label className="form-field">
          New project name
          <input name="name" required disabled={busy} />
        </label>
        <button className="primary" disabled={!live || busy}>
          Create project
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

const scopeLabels: Record<Scope, string> = { report: "Report", steer: "Steer" };

const mcpClients = {
  claude: { label: "Claude Code", path: ".mcp.json" },
  cursor: { label: "Cursor", path: "~/.cursor/mcp.json" },
  codex: { label: "Codex", path: "~/.codex/config.toml" },
} as const;

type McpClient = keyof typeof mcpClients;

function mcpConfig(client: McpClient, token: string) {
  const url = new URL("/mcp", window.location.origin).href;
  const authorization = `Bearer ${token}`;
  if (client === "codex") {
    return [
      "[mcp_servers.heed]",
      `url = ${JSON.stringify(url)}`,
      `http_headers = { Authorization = ${JSON.stringify(authorization)} }`,
    ].join("\n");
  }
  return JSON.stringify(
    {
      mcpServers: {
        heed: {
          ...(client === "claude" ? { type: "http" } : {}),
          url,
          headers: { Authorization: authorization },
        },
      },
    },
    null,
    2,
  );
}

function TokenReveal({
  created,
  close,
}: {
  created: CreatedToken;
  close: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [client, setClient] = useState<McpClient>("claude");
  const config = mcpConfig(client, created.token);
  const { label, path } = mcpClients[client];
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback(`${label} copied.`);
    } catch {
      setFeedback("Select the text and copy it manually.");
    }
  }

  return (
    <div className="token-reveal">
      <h4>Token created</h4>
      <p>Copy this token now. It’s shown only once.</p>
      <label className="form-field">
        API token
        <input
          readOnly
          value={created.token}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <button
        type="button"
        className="subtle"
        onClick={() => void copy(created.token, "Token")}
      >
        Copy token
      </button>
      <label className="form-field">
        MCP client
        <select
          value={client}
          onChange={(event) => {
            setClient(event.target.value as McpClient);
            setFeedback("");
          }}
        >
          {Object.entries(mcpClients).map(([id, { label }]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field">
        {label} MCP config ({path})
        <textarea
          rows={client === "codex" ? 4 : 9}
          readOnly
          value={config}
          spellCheck={false}
        />
      </label>
      <p className="muted">
        Keep this configuration private. It contains your API token.
      </p>
      <div className="inline-actions">
        <button
          type="button"
          className="subtle"
          onClick={() => void copy(config, "MCP config")}
        >
          Copy MCP config
        </button>
        <button type="button" className="primary" onClick={close}>
          Done
        </button>
      </div>
      <small role="status">{feedback}</small>
    </div>
  );
}

function Tokens({
  projects,
  live,
  save,
}: SettingsActions & { projects: readonly Project[] }) {
  const { getJson } = useApi();
  const [tokens, setTokens] = useState<TokenMetadata[]>();
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [created, setCreated] = useState<CreatedToken>();
  const { busy, error, run } = useAction();
  useEffect(() => {
    const controller = new AbortController();
    void getJson<TokenMetadata[]>("/api/tokens", controller.signal)
      .then((result) => {
        if (!Array.isArray(result))
          throw new Error("Couldn’t load API tokens.");
        if (!controller.signal.aborted) {
          setTokens(result);
          setLoadError("");
        }
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setLoadError(error.message);
      });
    return () => controller.abort();
  }, [getJson, retry]);

  return (
    <section className="settings-section" aria-labelledby="tokens-heading">
      <h3 id="tokens-heading">API tokens</h3>
      {loadError ? (
        <div className="inline-actions">
          <p role="alert">{loadError}</p>
          <button
            type="button"
            className="subtle"
            onClick={() => setRetry(retry + 1)}
          >
            Retry
          </button>
        </div>
      ) : !tokens ? (
        <p className="muted">Loading tokens…</p>
      ) : tokens.length ? (
        <ul className="settings-list">
          {tokens.map((token) => (
            <li key={token.id} className="token-row">
              <div>
                <strong>{token.label}</strong>
                <small>
                  {scopeLabels[token.scope]} ·{" "}
                  {projects.find(({ id }) => id === token.default_project_id)
                    ?.name ?? "Inbox by default"}
                </small>
              </div>
              <button
                type="button"
                className="subtle danger"
                disabled={!live || busy}
                aria-label={`Revoke ${token.label}`}
                onClick={() => {
                  if (!window.confirm(`Revoke “${token.label}”?`)) return;
                  void run(async () => {
                    await save({
                      type: "REVOKE_TOKEN",
                      input: { token_id: token.id },
                    });
                    setTokens((tokens) =>
                      tokens?.filter(({ id }) => id !== token.id),
                    );
                    if (created?.id === token.id) setCreated(undefined);
                  });
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No API tokens yet.</p>
      )}
      {created ? (
        <TokenReveal created={created} close={() => setCreated(undefined)} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            void run(async () => {
              const { createdToken } = await save(
                {
                  type: "CREATE_TOKEN",
                  input: {
                    label: String(data.get("label")).trim(),
                    scope: ScopeSchema.parse(data.get("scope")),
                    default_project_id: String(data.get("project")) || null,
                  },
                },
                { callerReportsError: true },
              );
              if (!createdToken)
                throw new Error(
                  "The token response was missing. Check the token list.",
                );
              const { token, ...metadata } = createdToken;
              setTokens((tokens) => [...(tokens ?? []), metadata]);
              setCreated({ ...metadata, token });
              form.reset();
            });
          }}
        >
          <fieldset className="form-stack" disabled={!live || busy || !tokens}>
            <div className="form-grid">
              <label className="form-field">
                Label
                <input name="label" required maxLength={200} />
              </label>
              <label className="form-field">
                Scope
                <select name="scope">
                  {ScopeSchema.options.map((scope) => (
                    <option key={scope} value={scope}>
                      {scopeLabels[scope]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                Default project
                <select name="project">
                  <option value="">Use Inbox</option>
                  <ProjectOptions projects={projects} />
                </select>
              </label>
            </div>
            <div>
              <button className="primary">
                {busy ? "Working…" : "Create token"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function Account({
  timezone,
  email,
  live,
  save,
  onSignOut,
}: SettingsActions & {
  timezone: string;
  email: string;
  onSignOut?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>();
  const { busy, error, run } = useAction();
  const value = (draft ?? timezone).trim();
  return (
    <section className="settings-section" aria-labelledby="account-heading">
      <h3 id="account-heading">Workspace and account</h3>
      <form
        className="inline-actions settings-add"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = TimezoneSchema.safeParse(value);
            if (!result.success)
              throw new Error("Enter an IANA timezone such as Europe/Tallinn.");
            await save({
              type: "SET_TIMEZONE",
              input: { timezone: result.data },
            });
            setDraft(undefined);
          });
        }}
      >
        <label className="form-field">
          Workspace timezone
          <input
            value={draft ?? timezone}
            required
            disabled={busy}
            placeholder="Europe/Tallinn"
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          className="subtle"
          disabled={!live || busy || value === timezone}
        >
          Save timezone
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <form
        action="/auth/logout"
        method="post"
        className="inline-actions settings-add"
        onSubmit={
          onSignOut &&
          ((event) => {
            event.preventDefault();
            void run(onSignOut);
          })
        }
      >
        <p className="muted">Signed in as {email}</p>
        <button className="subtle" disabled={onSignOut ? busy : undefined}>
          Sign out
        </button>
      </form>
    </section>
  );
}

function ExtraSettings({
  screen,
  screenProps,
}: {
  screen: SettingsScreen;
  screenProps: SettingsScreenProps;
}) {
  const heading = useId();
  const Component = screen.component;
  return (
    <section className="settings-section" aria-labelledby={heading}>
      <h3 id={heading}>{screen.label}</h3>
      <Component {...screenProps} />
    </section>
  );
}

function WorkspaceData({ live, save }: SettingsActions) {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [reset, setReset] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  const confirmed = confirmation === RESET_WORKSPACE_CONFIRMATION;

  useEffect(() => {
    if (confirming) confirmationInput.current?.focus();
  }, [confirming]);

  return (
    <section
      className="settings-section"
      aria-labelledby="workspace-data-heading"
    >
      <h3 id="workspace-data-heading">Data</h3>
      <div className="settings-row form-stack">
        <h4>Export</h4>
        <p className="muted">
          Download one JSON file with workspace settings and guidance, projects,
          items, dependencies, and event history. API tokens, OAuth grants, and
          push subscriptions are excluded.
        </p>
        <div className="inline-actions">
          <a className="subtle settings-download" href="/api/export" download>
            Export
          </a>
        </div>
      </div>
      <div className="settings-row form-stack">
        <h4>Reset workspace</h4>
        <p className="muted">
          Permanently delete all workspace data, revoke API tokens and OAuth
          grants, and remove push subscriptions. The workspace starts over with
          an empty Inbox.
        </p>
        {!confirming && (
          <div>
            <button
              ref={resetButton}
              type="button"
              className="subtle danger"
              disabled={!live}
              onClick={() => {
                setConfirmation("");
                setReset(false);
                setConfirming(true);
              }}
            >
              Reset workspace
            </button>
          </div>
        )}
        {confirming && (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!confirmed || !live) return;
              void run(async () => {
                await save(
                  {
                    type: "RESET_WORKSPACE",
                    input: { confirmation: RESET_WORKSPACE_CONFIRMATION },
                  },
                  { callerReportsError: true },
                );
                setReset(true);
                setConfirming(false);
              });
            }}
          >
            <div className="inline-actions">
              <a
                className="subtle settings-download"
                href="/api/export"
                download
              >
                Export before resetting
              </a>
            </div>
            <label className="form-field">
              Type {RESET_WORKSPACE_CONFIRMATION} to confirm
              <input
                ref={confirmationInput}
                value={confirmation}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <div className="inline-actions">
              <button
                type="submit"
                className="subtle danger"
                disabled={!confirmed || !live || busy}
              >
                {busy ? "Resetting…" : "Permanently reset workspace"}
              </button>
              <button
                type="button"
                className="subtle"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  requestAnimationFrame(() => resetButton.current?.focus());
                }}
              >
                Cancel
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
          </form>
        )}
        {reset && (
          <p role="status">Workspace reset. Your Inbox is now empty.</p>
        )}
      </div>
    </section>
  );
}

export function Settings({
  projects,
  items,
  timezone,
  screenProps,
  options,
  showModelKeyHint,
  onSignOut,
  live,
  save,
  resetVersion,
  close,
  focus,
  openGuide,
  demoLoaded,
}: SettingsActions & {
  projects: readonly Project[];
  items: ReadonlyMap<string, Item>;
  timezone: string;
  screenProps: SettingsScreenProps;
  options?: MountAppOptions;
  showModelKeyHint: boolean;
  resetVersion: number;
  onSignOut?: () => Promise<void>;
  close: () => void;
  focus?: OnboardingScreen;
  openGuide?: () => void;
  demoLoaded: boolean;
}) {
  const hidden = options?.hideScreens ?? [];
  const show = (id: BuiltInScreenId) =>
    (!focus || focus === id) && !hidden.includes(id);
  return (
    <Panel title="Settings" close={close} className="settings-panel">
      {!focus && openGuide && (
        <section className="settings-section" aria-labelledby="setup-heading">
          <h3 id="setup-heading">Workspace setup</h3>
          <div className="inline-actions">
            <button type="button" className="subtle" onClick={openGuide}>
              Open setup guide
            </button>
            <DemoDataButton
              loaded={demoLoaded}
              live={live}
              save={save}
              onLoad={close}
            />
          </div>
        </section>
      )}
      {show("notifications") && <PushSettings key={resetVersion} />}
      {show("projects") && (
        <Projects projects={projects} items={items} live={live} save={save} />
      )}
      {show("tokens") && (
        <Tokens
          key={resetVersion}
          projects={projects}
          live={live}
          save={save}
        />
      )}
      {show("account") && (
        <Account
          timezone={timezone}
          email={screenProps.user.email}
          live={live}
          save={save}
          onSignOut={onSignOut}
        />
      )}
      {showModelKeyHint && show("model-keys") && (
        <section
          className="settings-section"
          aria-labelledby="model-keys-heading"
        >
          <h3 id="model-keys-heading">Model keys</h3>
          <ModelKeyHint />
        </section>
      )}
      {screenProps.role === "owner" && show("data") && (
        <WorkspaceData live={live} save={save} />
      )}
      {!focus &&
        options?.extraSettingsScreens?.map((screen) => (
          <ExtraSettings
            key={screen.id}
            screen={screen}
            screenProps={screenProps}
          />
        ))}
    </Panel>
  );
}
