import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ConnectedApp, Item, TokenMetadata } from "@heedwork/core";
import { useResource } from "./api";
import { Panel, parseInstant, useAction } from "./workspace-controls";
import type { SaveMutation } from "./workspace-controls";

export interface AgentRow {
  kind: "token" | "app";
  id: string;
  label: string;
  scope: TokenMetadata["scope"];
  last_used_at: string | null;
  client_name?: string;
  /** The first open item this agent is actively working on. */
  working?: Item;
}

const TAB_STORAGE_KEY = "heed.agents.tab";
const tabs = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "other", label: "Other" },
] as const;
type TabId = (typeof tabs)[number]["id"];

function lastUsed(value: string | null) {
  if (!value) return -Infinity;
  const instant = parseInstant(value);
  return Number.isFinite(instant) ? instant : -Infinity;
}

/** Merges tokens and connected apps: working first, then most recently used. */
export function agentRows(
  tokens: readonly TokenMetadata[],
  apps: readonly ConnectedApp[],
  items: Iterable<Item>,
): AgentRow[] {
  const active = [...items].filter(({ status }) => status === "active");
  const rows: AgentRow[] = [
    ...apps.map((app) => ({ kind: "app" as const, ...app })),
    ...tokens.map(({ id, label, scope, last_used_at }) => ({
      kind: "token" as const,
      id,
      label,
      scope,
      last_used_at,
    })),
  ].map((row) => {
    const name = row.label.toLowerCase();
    const working = active.find(
      ({ agent_name }) => agent_name?.toLowerCase() === name,
    );
    return working ? { ...row, working } : row;
  });
  return rows.sort(
    (a, b) =>
      Number(Boolean(b.working)) - Number(Boolean(a.working)) ||
      lastUsed(b.last_used_at) - lastUsed(a.last_used_at),
  );
}

export function relativeTime(value: string, now: number) {
  const instant = parseInstant(value);
  if (!Number.isFinite(instant)) return value;
  const minutes = Math.max(0, Math.floor((now - instant) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function readTab(): TabId {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    return tabs.find(({ id }) => id === stored)?.id ?? "claude";
  } catch {
    return "claude";
  }
}

function Snippet({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLPreElement>(null);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  function selectText() {
    const node = code.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    selection.selectAllChildren(node);
  }
  return (
    <div className="agent-snippet">
      <pre ref={code} tabIndex={0} aria-label={label}>
        {text}
      </pre>
      <button
        type="button"
        className="subtle"
        onClick={() => {
          // Start the write inside the click so browsers keep the user gesture.
          let write: Promise<void>;
          try {
            write = navigator.clipboard.writeText(text);
          } catch (error) {
            write = Promise.reject(error);
          }
          write.then(() => {
            setCopied(true);
            clearTimeout(reset.current);
            reset.current = setTimeout(() => setCopied(false), 1500);
          }, selectText);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ConnectInstructions({ showList }: { showList: boolean }) {
  const [tab, setTab] = useState<TabId>(readTab);
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const url = `${window.location.origin}/mcp`;
  const appears = showList && (
    <li>It appears in the list above as soon as it connects.</li>
  );
  function choose(id: TabId) {
    setTab(id);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, id);
    } catch {
      // Private browsing can refuse storage. The choice lasts for this view.
    }
  }
  function onKeyDown(event: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = tabs.findIndex(({ id }) => id === tab);
    const next = tabs[(index + step + tabs.length) % tabs.length].id;
    choose(next);
    tabRefs.current.get(next)?.focus();
  }
  const steps = {
    claude: (
      <>
        <li>
          Run this in a terminal:
          <Snippet
            label="Claude Code command"
            text={`claude mcp add --transport http heed ${url}`}
          />
        </li>
        <li>
          In Claude Code, run <code>/mcp</code>, choose heed and sign in. Give
          it a name you will recognise, like claude-code.
        </li>
        {appears}
      </>
    ),
    cursor: (
      <>
        <li>
          Add this to <code>~/.cursor/mcp.json</code>:
          <Snippet
            label="Cursor configuration"
            text={JSON.stringify({ mcpServers: { heed: { url } } }, null, 2)}
          />
        </li>
        <li>
          Open Cursor’s MCP settings and sign in to heed. Give it a name you
          will recognise, like cursor.
        </li>
        {appears}
      </>
    ),
    codex: (
      <>
        <li>
          Add this to <code>~/.codex/config.toml</code>:
          <Snippet
            label="Codex configuration"
            text={`[mcp_servers.heed]\nurl = ${JSON.stringify(url)}`}
          />
        </li>
        <li>
          In Codex, run <code>/mcp</code> and sign in to heed. Give it a name
          you will recognise, like codex.
        </li>
        {appears}
      </>
    ),
    other: (
      <>
        <li>
          Use this MCP address:
          <Snippet label="MCP address" text={url} />
        </li>
        <li>
          Add it as a remote Streamable HTTP server and use the client’s Sign
          in.{showList && " If it can’t sign in, ask for a token below."}
        </li>
        {appears}
      </>
    ),
  }[tab];
  return (
    <section className="agents-section" aria-labelledby="agents-connect">
      <h3 id="agents-connect">Connect an agent</h3>
      <div className="agents-tabs" role="tablist" aria-label="Agent client">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            ref={(node) => {
              if (node) tabRefs.current.set(id, node);
              else tabRefs.current.delete(id);
            }}
            type="button"
            role="tab"
            id={`agents-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="agents-tab-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => choose(id)}
            onKeyDown={onKeyDown}
          >
            {label}
          </button>
        ))}
      </div>
      <ol
        className="agents-steps"
        role="tabpanel"
        id="agents-tab-panel"
        aria-labelledby={`agents-tab-${tab}`}
      >
        {steps}
      </ol>
      <p className="muted agents-note">
        Sign-in gives the agent Report access: it can add and update work and
        ask you questions. Choose Steer on the sign-in screen only for an agent
        you trust to change projects and guidance.
      </p>
    </section>
  );
}

function AgentListRow({
  row,
  now,
  live,
  disconnect,
}: {
  row: AgentRow;
  now: number;
  live: boolean;
  disconnect: (row: AgentRow) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <li className="agent-row" data-working={Boolean(row.working)}>
      <div className="agent-row-title">
        <span className="agent-status" aria-hidden="true" />
        <strong>{row.label}</strong>
        <span className="agent-scope" data-scope={row.scope}>
          {row.scope === "steer" ? "Steer" : "Report"}
        </span>
      </div>
      <div className="agent-row-meta">
        <span className="agent-activity">
          {row.working
            ? `Working on ${row.working.title}`
            : row.last_used_at
              ? `Last seen ${relativeTime(row.last_used_at, now)}`
              : "Never used"}
        </span>
        {confirming ? (
          <span className="agent-row-actions" role="group">
            <span>Disconnect {row.label}?</span>
            <button
              type="button"
              className="text-control"
              disabled={busy || !live}
              onClick={() => void run(() => disconnect(row))}
            >
              Yes
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className="text-control"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              No
            </button>
          </span>
        ) : (
          <span className="agent-row-actions">
            <span>
              {row.kind === "app" ? `Signed in · ${row.client_name}` : "Token"}
            </span>
            <button
              type="button"
              className="text-control"
              aria-label={`Disconnect ${row.label}`}
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </button>
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="agent-row-error">
          {error}
        </p>
      )}
    </li>
  );
}

function ConnectedList({
  items,
  agentsConnected,
  now,
  live,
  save,
}: {
  items: ReadonlyMap<string, Item>;
  agentsConnected?: number;
  now: number;
  live: boolean;
  save: SaveMutation;
}) {
  const tokens = useResource<TokenMetadata[]>("/api/tokens", agentsConnected);
  const apps = useResource<ConnectedApp[]>(
    "/api/connected-apps",
    agentsConnected,
  );
  const loaded = tokens.data && apps.data;
  const rows = loaded
    ? agentRows(tokens.data!, apps.data!, items.values())
    : [];
  const failure = tokens.error ?? apps.error;
  async function disconnect(row: AgentRow) {
    await save(
      row.kind === "token"
        ? { type: "REVOKE_TOKEN", input: { token_id: row.id } }
        : { type: "REVOKE_CONNECTED_APP", input: { grant_id: row.id } },
      { callerReportsError: true },
    );
    tokens.reload();
    apps.reload();
  }
  return (
    <section className="agents-section" aria-labelledby="agents-connected">
      <h3 id="agents-connected">
        Connected{loaded ? ` · ${rows.length}` : ""}
      </h3>
      {failure && !loaded ? (
        <p role="alert">{failure.message}</p>
      ) : !loaded ? (
        <p className="muted">Loading agents…</p>
      ) : rows.length ? (
        <ul className="agent-list">
          {rows.map((row) => (
            <AgentListRow
              key={`${row.kind}:${row.id}`}
              row={row}
              now={now}
              live={live}
              disconnect={disconnect}
            />
          ))}
        </ul>
      ) : (
        <p className="muted">No agents connected yet.</p>
      )}
    </section>
  );
}

export function AgentsPanel({
  close,
  showConnections,
  ...list
}: {
  close: () => void;
  /** False when the host hides tokens and connected apps. */
  showConnections: boolean;
  items: ReadonlyMap<string, Item>;
  agentsConnected?: number;
  now: number;
  live: boolean;
  save: SaveMutation;
}) {
  return (
    <Panel title="Agents" close={close} className="agents-panel">
      {showConnections && <ConnectedList {...list} />}
      <ConnectInstructions showList={showConnections} />
      {showConnections && (
        <section className="agents-section" aria-labelledby="agents-ask">
          <h3 id="agents-ask">Or ask</h3>
          <p className="agents-example">
            <span aria-hidden="true">›</span> create a token for my CI bot
          </p>
          <p className="muted">
            For agents that can’t sign in, such as scripts and CI. The token is
            shown once, with the setup snippet.
          </p>
        </section>
      )}
    </Panel>
  );
}
