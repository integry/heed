import { useEffect, useId, useState } from "react";
import { INBOX_PROJECT_ID, ScopeSchema, TimezoneSchema } from "@heedwork/core";
import type {
  ConnectedApp,
  Item,
  Project,
  Scope,
  TokenMetadata,
} from "@heedwork/core";
import type { CreatedToken } from "@heedwork/core";
import { Panel, ProjectOptions, useAction } from "./workspace-controls";
import type { SaveMutation } from "./workspace-controls";
import { PushSettings } from "./PushSettings";
import { ModelKeyHint } from "./CommandBar";
import { useApi, useResource } from "./api";
import type {
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

function TokenReveal({
  created,
  close,
}: {
  created: CreatedToken;
  close: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const config = JSON.stringify(
    {
      mcpServers: {
        heed: {
          type: "http",
          url: new URL("/mcp", window.location.origin).href,
          headers: { Authorization: `Bearer ${created.token}` },
        },
      },
    },
    null,
    2,
  );
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
        Claude Code MCP config (.mcp.json)
        <textarea rows={7} readOnly value={config} spellCheck={false} />
      </label>
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
      <ConnectedApps live={live} save={save} />
    </section>
  );
}

function ConnectedApps({ live, save }: SettingsActions) {
  const { data, error, loading, reload } = useResource<ConnectedApp[]>(
    "/api/connected-apps",
  );
  const action = useAction();

  return (
    <section
      className="connected-apps"
      aria-labelledby="connected-apps-heading"
    >
      <h4 id="connected-apps-heading">Connected apps</h4>
      {loading ? (
        <p className="muted">Loading connected apps…</p>
      ) : error || !Array.isArray(data) ? (
        <div className="inline-actions">
          <p role="alert">Couldn’t load connected apps.</p>
          <button type="button" className="subtle" onClick={reload}>
            Retry
          </button>
        </div>
      ) : data.length ? (
        <ul className="settings-list">
          {data.map((grant) => (
            <li key={grant.id} className="token-row">
              <div>
                <strong>{grant.client_name}</strong>
                <small>
                  {grant.label} · {scopeLabels[grant.scope]}
                </small>
                <small>
                  {grant.last_used_at ? (
                    <>
                      Last used{" "}
                      <time dateTime={grant.last_used_at}>
                        {new Date(grant.last_used_at).toLocaleString()}
                      </time>
                    </>
                  ) : (
                    "Never used"
                  )}
                </small>
              </div>
              <button
                type="button"
                className="subtle danger"
                disabled={!live || action.busy}
                aria-label={`Revoke ${grant.client_name} (${grant.label})`}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Revoke access for “${grant.client_name}” (${grant.label})?`,
                    )
                  )
                    return;
                  void action.run(async () => {
                    await save({
                      type: "REVOKE_CONNECTED_APP",
                      input: { grant_id: grant.id },
                    });
                    reload();
                  });
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No apps connected with sign-in yet.</p>
      )}
      {action.error && <p role="alert">{action.error}</p>}
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
  close,
}: SettingsActions & {
  projects: readonly Project[];
  items: ReadonlyMap<string, Item>;
  timezone: string;
  screenProps: SettingsScreenProps;
  options?: MountAppOptions;
  showModelKeyHint: boolean;
  onSignOut?: () => Promise<void>;
  close: () => void;
}) {
  const hidden = options?.hideScreens ?? [];
  return (
    <Panel title="Settings" close={close} className="settings-panel">
      {!hidden.includes("notifications") && <PushSettings />}
      {!hidden.includes("projects") && (
        <Projects projects={projects} items={items} live={live} save={save} />
      )}
      {!hidden.includes("tokens") && (
        <Tokens projects={projects} live={live} save={save} />
      )}
      {!hidden.includes("account") && (
        <Account
          timezone={timezone}
          email={screenProps.user.email}
          live={live}
          save={save}
          onSignOut={onSignOut}
        />
      )}
      {showModelKeyHint && !hidden.includes("model-keys") && (
        <section
          className="settings-section"
          aria-labelledby="model-keys-heading"
        >
          <h3 id="model-keys-heading">Model keys</h3>
          <ModelKeyHint />
        </section>
      )}
      {options?.extraSettingsScreens?.map((screen) => (
        <ExtraSettings
          key={screen.id}
          screen={screen}
          screenProps={screenProps}
        />
      ))}
    </Panel>
  );
}
