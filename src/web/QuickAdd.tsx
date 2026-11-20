import { useState } from "react";
import { INBOX_PROJECT_ID } from "../shared/workspace";
import type { Item, Project, TimeType } from "../shared/workspace";
import {
  Panel,
  ProjectOptions,
  TimeFields,
  timeInputInstant,
  useAction,
} from "./workspace-controls";
import type { SaveMutation } from "./workspace-controls";

export const depthLimitMessage =
  "This item is a sub-task. Add another sub-task under its parent.";

export function QuickAdd({
  parent,
  parentMissing,
  projects,
  timezone,
  live,
  save,
  close,
}: {
  parent?: Item;
  parentMissing: boolean;
  projects: readonly Project[];
  timezone: string;
  live: boolean;
  save: SaveMutation;
  close: () => void;
}) {
  const [type, setType] = useState<TimeType>("flexible");
  const [at, setAt] = useState("");
  const { busy, error, run } = useAction();
  const capped = parent?.depth === 3;
  return (
    <Panel
      title={parent || parentMissing ? "Add child item" : "Add a goal"}
      close={close}
      className="quick-add"
    >
      {parentMissing ? (
        <p>The parent item is no longer available.</p>
      ) : capped ? (
        <p>{depthLimitMessage}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              const title = String(data.get("title")).trim();
              if (!title) throw new Error("Enter a title.");
              const date = String(data.get("date"));
              await save({
                type: "ADD_ITEM",
                input: {
                  title,
                  ...(parent
                    ? { parent_id: parent.id }
                    : { project: String(data.get("project")) }),
                  ...(date ? { scheduled_on: date } : {}),
                  ...(type === "flexible"
                    ? {}
                    : {
                        time_type: type,
                        time_at: timeInputInstant(at, timezone),
                      }),
                },
              });
              close();
            });
          }}
        >
          <fieldset className="form-stack" disabled={!live || busy}>
            {parent && <p className="muted">Under {parent.title}</p>}
            <label className="form-field">
              Title
              <input
                name="title"
                required
                placeholder={
                  parent ? "What needs doing?" : "What are you working toward?"
                }
              />
            </label>
            {!parent && (
              <label className="form-field">
                Project
                <select name="project" defaultValue={INBOX_PROJECT_ID}>
                  <ProjectOptions projects={projects} />
                </select>
              </label>
            )}
            <div className="form-grid">
              <label className="form-field">
                Schedule
                <input type="date" name="date" />
              </label>
              <TimeFields
                type={type}
                setType={setType}
                at={at}
                setAt={setAt}
                timezone={timezone}
              />
            </div>
            {error && <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="subtle" onClick={close}>
                Cancel
              </button>
              <button className="primary">
                {busy ? "Adding…" : parent ? "Add child" : "Add goal"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </Panel>
  );
}
