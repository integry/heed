import { useState } from "react";
import { GuidanceTextSchema, MAX_GUIDANCE_LENGTH } from "@heedwork/core";
import type { Settings } from "@heedwork/core";
import { dateLabel, Panel, useAction } from "./workspace-controls";
import type { SaveMutation } from "./workspace-controls";

export function Guidance({
  settings,
  live,
  save,
  close,
}: {
  settings: Settings;
  live: boolean;
  save: SaveMutation;
  close: () => void;
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || draft === settings.guidance) return;
          void run(async () => {
            await save(
              { type: "SET_GUIDANCE", input: { text: draft } },
              { callerReportsError: true },
            );
            setEdit(undefined);
            setSaved(true);
          });
        }}
      >
        <label className="form-field">
          Instructions for your agents
          <textarea
            autoFocus
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
