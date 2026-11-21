import { useState } from "react";
import { GuidanceTextSchema, MAX_GUIDANCE_LENGTH } from "@heedwork/core";
import type { Settings } from "@heedwork/core";
import { dateLabel, Panel, useAction } from "./workspace-controls";
import type { SaveMutation } from "./workspace-controls";

const examples = [
  {
    label: "Prioritize customer impact",
    text: "Put customer-facing incidents in Today and give them priority 9. Keep routine cleanup in the backlog.",
  },
  {
    label: "Make progress visible",
    text: "Split goals into tasks that can be finished in one session. Report a short note when you complete a task or discover a blocker.",
  },
  {
    label: "Ask for input",
    text: "Flag a handoff when you need a decision, review, or access from me. Notify me only if the blocker prevents work due today.",
  },
];

export function Guidance({
  settings,
  live,
  save,
  close,
  showExamples = false,
}: {
  settings: Settings;
  live: boolean;
  save: SaveMutation;
  close: () => void;
  showExamples?: boolean;
}) {
  const [edit, setEdit] = useState<string>();
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const draft = edit ?? settings.guidance;
  const count = [...draft].length;
  const valid = GuidanceTextSchema.safeParse(draft).success;
  return (
    <Panel title="Guidance" close={close}>
      <p className="panel-intro">
        Agents and the command bar use this guidance to place and prioritize
        work, break it into tasks, and decide when to notify you.
      </p>
      {showExamples && (
        <details className="guidance-examples" open>
          <summary>Guidance examples</summary>
          <ul>
            {examples.map(({ label, text }) => (
              <li key={label}>
                <strong>{label}</strong>
                <p>{text}</p>
                <button
                  type="button"
                  className="subtle"
                  aria-label={`Use example: ${label}`}
                  disabled={busy || draft.includes(text)}
                  onClick={() => {
                    setEdit(
                      [draft.trimEnd(), text].filter(Boolean).join("\n\n"),
                    );
                    setSaved(false);
                  }}
                >
                  Use example
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || draft === settings.guidance) return;
          void run(async () => {
            await save({ type: "SET_GUIDANCE", input: { text: draft } });
            setEdit(undefined);
            setSaved(true);
          });
        }}
      >
        <label className="form-field">
          Instructions for your agents
          <textarea
            rows={7}
            value={draft}
            disabled={busy}
            aria-invalid={!valid}
            aria-describedby="guidance-count"
            onChange={(event) => {
              setEdit(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <div className="guidance-meta">
          <small className="muted">
            {settings.guidance_updated_at
              ? `Updated ${dateLabel(settings.guidance_updated_at, settings.timezone)}`
              : "Never updated"}
          </small>
          <small id="guidance-count" data-invalid={!valid}>
            {count.toLocaleString("en-US")} /{" "}
            {MAX_GUIDANCE_LENGTH.toLocaleString("en-US")}
          </small>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <span role="status" className="muted">
            {saved ? "Guidance saved." : ""}
          </span>
          <button
            className="primary"
            disabled={!live || busy || !valid || draft === settings.guidance}
          >
            {busy ? "Saving…" : "Save guidance"}
          </button>
        </div>
      </form>
    </Panel>
  );
}
