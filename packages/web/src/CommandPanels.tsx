import { useState } from "react";
import {
  CreateTokenSchema,
  type CreatedToken,
  type JudgeAgreement,
  type Scope,
} from "@heedwork/core";
import { useResource } from "./api";
import { Panel, useAction } from "./workspace-controls";

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

export function TokenSecret({ created }: { created: CreatedToken }) {
  const [feedback, setFeedback] = useState("");
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback(`${label} copied.`);
    } catch {
      setFeedback("Clipboard unavailable. Copy the text manually.");
    }
  }
  return (
    <div className="form-stack">
      <p>Copy this token now. It’s shown only once.</p>
      <input
        className="token-secret"
        aria-label="API token"
        value={created.token}
        readOnly
        spellCheck={false}
        autoComplete="off"
      />
      <div>
        <button
          type="button"
          className="subtle"
          onClick={() => void copy(created.token, "Token")}
        >
          Copy token
        </button>
      </div>
      {Object.entries(mcpClients).map(([id, { label, path }]) => {
        const config = mcpConfig(id as McpClient, created.token);
        return (
          <details key={id}>
            <summary>{label} setup</summary>
            <p className="muted">{path}</p>
            <pre className="token-config" tabIndex={0}>
              {config}
            </pre>
            <button
              type="button"
              className="subtle"
              onClick={() => void copy(config, "MCP config")}
            >
              Copy {label} config
            </button>
          </details>
        );
      })}
      <small role="status">{feedback}</small>
    </div>
  );
}

export function TokenLabel({
  create,
  close,
  scope,
  projectName,
}: {
  create: (label: string) => Promise<void>;
  close: () => void;
  scope: Scope;
  projectName: string;
}) {
  const [label, setLabel] = useState("");
  const { run, busy, error } = useAction();
  return (
    <Panel title="New API token" close={close} busy={busy}>
      <p>
        Scope {scope} · Default project {projectName}
      </p>
      <p className="muted">
        To choose options from the command line, try{" "}
        <code>new steer token in &lt;project&gt;</code>.
      </p>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = CreateTokenSchema.safeParse({ label });
          if (parsed.success) void run(() => create(parsed.data.label));
        }}
      >
        <label className="form-field">
          Token label
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={200}
            required
            autoFocus
            disabled={busy}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button
          type="submit"
          className="primary"
          disabled={busy || !label.trim()}
        >
          Create token
        </button>
      </form>
    </Panel>
  );
}

export function ConfirmCommand({
  phrase,
  description,
  confirm,
}: {
  phrase: string;
  description: string;
  confirm: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const { run, busy, error } = useAction();
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (value === phrase) void run(confirm);
      }}
    >
      <p>{description}</p>
      <label className="form-field">
        Type {phrase} to confirm
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        type="submit"
        className="subtle danger"
        disabled={busy || value !== phrase}
      >
        Confirm
      </button>
    </form>
  );
}

export function ShadowJudgeAgreement({ revision }: { revision: number }) {
  const { data, error, reload } = useResource<JudgeAgreement>(
    "/api/judge/agreement",
    revision,
  );
  const agreement = data?.reviewed
    ? new Intl.NumberFormat(undefined, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(data.agreed / data.reviewed)
    : "—";
  return (
    <div>
      {error ? (
        <div className="inline-actions">
          <p role="alert">Couldn’t load judge agreement.</p>
          <button type="button" className="subtle" onClick={reload}>
            Retry
          </button>
        </div>
      ) : !data ? (
        <p className="muted">Loading judge agreement…</p>
      ) : !data.verdicts ? (
        <p className="muted">
          No verdicts yet. Judging is optional and configured by your host.
        </p>
      ) : (
        <dl className="judge-totals">
          <div>
            <dt>Verdicts</dt>
            <dd>{data.verdicts}</dd>
          </div>
          <div>
            <dt>With feedback</dt>
            <dd>{data.reviewed}</dd>
          </div>
          <div>
            <dt>Agreement rate</dt>
            <dd>{agreement}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
