import { useEffect, useState } from "react";
import { LockableFieldSchema } from "../shared/item-operations";
import type { LockableField, UpdateItemInput } from "../shared/item-operations";
import { effectiveSchedule } from "../shared/derived-state";
import type {
  Dependency,
  Event,
  Item,
  Project,
  TimeType,
} from "../shared/workspace";
import { depthLimitMessage } from "./QuickAdd";
import {
  dateLabel,
  ProjectOptions,
  readApi,
  TimeFields,
  timeInputInstant,
  timeInputValue,
  useAction,
} from "./workspace-controls";
import type { SaveMutation } from "./workspace-controls";

const lockLabels: Record<LockableField, string> = {
  priority: "Priority",
  scheduled_on: "Schedule",
  sort_key: "Stream order",
  layout_pos: "Canvas position",
};

function eventSummary(event: Event) {
  const detail = JSON.parse(event.detail ?? "null");
  switch (event.kind) {
    case "created":
      return "Created item";
    case "status":
      return detail?.new ? `Status changed to ${detail.new}` : "Changed status";
    case "note":
      return detail?.new ? `Updated note · ${detail.new}` : "Cleared note";
    case "handoff":
      return detail?.handoff
        ? `Flagged handoff · ${detail.note ?? ""}`
        : "Cleared handoff";
    case "reopened":
      return detail?.reason ? `Reopened · ${detail.reason}` : "Reopened";
    case "moved":
      return "Updated placement";
    case "notified":
      return "Sent a notification";
  }
}

function Activity({ item, timezone }: { item: Item; timezone: string }) {
  const [result, setResult] = useState<{ events?: Event[]; error?: string }>(
    {},
  );
  const [retry, setRetry] = useState(0);
  const itemId = item.id;
  // Heartbeat and layout broadcasts do not add activity entries.
  const eventFields = JSON.stringify([
    item.status,
    item.note,
    item.handoff,
    item.handoff_note,
    item.reopen_count,
    item.scheduled_on,
    item.project_id,
    item.parent_id,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    void readApi<Event[]>(
      `/api/items/${encodeURIComponent(itemId)}/events`,
      controller.signal,
    )
      .then((events) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(events)) throw new Error("Couldn’t load activity.");
        setResult({ events });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setResult({ error: error.message });
      });
    return () => controller.abort();
  }, [itemId, eventFields, retry]);

  return (
    <section className="inspector-section">
      <h3>Activity</h3>
      {result.error ? (
        <div className="inline-actions">
          <p role="alert">{result.error}</p>
          <button
            type="button"
            className="subtle"
            onClick={() => setRetry(retry + 1)}
          >
            Retry
          </button>
        </div>
      ) : !result.events ? (
        <p className="muted">Loading activity…</p>
      ) : result.events.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <ol className="activity-list">
          {result.events.map((event) => (
            <li key={event.id}>
              <span>{eventSummary(event)}</span>
              <small>
                {event.actor} · <time>{dateLabel(event.at, timezone)}</time>
              </small>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type DetailDraft = {
  project: string;
  tags: string;
  priority: number;
  schedule: string;
  timeType: TimeType;
  timeAt: string;
  link: string;
};

function safeLink(value: string) {
  const url = URL.parse(value);
  return url && (url.protocol === "https:" || url.protocol === "http:")
    ? url.href
    : undefined;
}

export function Inspector({
  item,
  projects,
  items,
  dependencies,
  timezone,
  live,
  save,
  close,
  addChild,
}: {
  item: Item;
  projects: readonly Project[];
  items: ReadonlyMap<string, Item>;
  dependencies: readonly Dependency[];
  timezone: string;
  live: boolean;
  save: SaveMutation;
  close: () => void;
  addChild: () => void;
}) {
  const [title, setTitle] = useState<string>();
  const [note, setNote] = useState<string>();
  const [details, setDetails] = useState<Partial<DetailDraft>>({});
  const [action, setAction] = useState<"handoff" | "reopen">();
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const { run, error, busy } = useAction();
  const baseline: DetailDraft = {
    project: item.project_id,
    tags: (JSON.parse(item.tags) as string[]).join(", "),
    priority: item.priority,
    schedule: item.scheduled_on ?? "",
    timeType: item.time_type,
    timeAt: timeInputValue(item.time_at, timezone),
    link: item.ref_url ?? "",
  };
  const draft = { ...baseline, ...details };
  const dirty = (Object.keys(details) as (keyof DetailDraft)[]).some(
    (field) => draft[field] !== baseline[field],
  );
  const disabled = !live || busy;
  const terminal = item.status === "done" || item.status === "cancelled";
  const item_id = item.id;
  const project = projects.find(({ id }) => id === item.project_id);
  const locks = LockableFieldSchema.array().parse(
    JSON.parse(item.locked_fields),
  );
  const blockers = dependencies.filter((edge) => edge.item_id === item_id);
  const choices = [...items.values()]
    .filter(
      (candidate) =>
        candidate.id !== item_id &&
        candidate.status !== "cancelled" &&
        !blockers.some((edge) => edge.blocked_by_id === candidate.id),
    )
    .sort((a, b) => a.title.localeCompare(b.title));
  const link = item.ref_url && safeLink(item.ref_url);
  const inherited =
    !draft.schedule && item.parent_id
      ? effectiveSchedule({ ...item, scheduled_on: null }, items)
      : null;

  function edit<Field extends keyof DetailDraft>(
    field: Field,
    value: DetailDraft[Field],
  ) {
    setDetails((previous) => ({ ...previous, [field]: value }));
  }

  function update(patch: Omit<UpdateItemInput, "item_id">) {
    return save({ type: "UPDATE_ITEM", input: { item_id, ...patch } });
  }

  function saveDetails() {
    return run(async () => {
      const patch: Omit<UpdateItemInput, "item_id"> = {};
      if (draft.project !== baseline.project) patch.project = draft.project;
      if (draft.priority !== baseline.priority) patch.priority = draft.priority;
      if (draft.schedule !== baseline.schedule)
        patch.scheduled_on = draft.schedule || null;
      if (draft.tags !== baseline.tags)
        patch.tags = draft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
      if (draft.link !== baseline.link) {
        const value = draft.link.trim();
        if (value && !safeLink(value))
          throw new Error("Enter an HTTP or HTTPS link.");
        patch.ref_url = value || null;
      }
      if (draft.timeType !== baseline.timeType)
        patch.time_type = draft.timeType;
      if (draft.timeType === "flexible") {
        if (patch.time_type) patch.time_at = null;
      } else if (draft.timeAt !== baseline.timeAt || !item.time_at) {
        patch.time_at = timeInputInstant(draft.timeAt, timezone);
      }
      await update(patch);
      setDetails({});
    });
  }

  return (
    <aside className="inspector" aria-labelledby="inspector-heading">
      <header className="panel-heading inspector-heading">
        <h2 id="inspector-heading">Inspector</h2>
        <button type="button" className="subtle" onClick={close}>
          Close
        </button>
      </header>
      <div className="inspector-body">
        <form
          className="inspector-title"
          onSubmit={(event) => {
            event.preventDefault();
            const value = (title ?? item.title).trim();
            if (!value || value === item.title) return;
            void run(async () => {
              await update({ title: value });
              setTitle(undefined);
            });
          }}
        >
          <label className="form-field">
            Title
            <input
              required
              value={title ?? item.title}
              disabled={disabled}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {title !== undefined && title.trim() !== item.title && (
            <button className="subtle" disabled={disabled}>
              Save title
            </button>
          )}
        </form>
        <div className="inspector-summary">
          <strong className="status-pill">{item.status}</strong>
          <span>{item.agent_name ?? "Human"}</span>
          {item.hidden === 1 && <span className="muted">Hidden</span>}
          <small className="muted">
            Last heartbeat{" "}
            {item.last_heartbeat_at
              ? dateLabel(item.last_heartbeat_at, timezone)
              : "—"}
          </small>
        </div>
        {error && (
          <p className="action-error" role="alert">
            {error}
          </p>
        )}
        {item.handoff === 1 && (
          <div className="handoff-card">
            <strong>Needs input</strong>
            {item.handoff_note && <p>{item.handoff_note}</p>}
            <button
              type="button"
              className="subtle"
              disabled={disabled}
              onClick={() =>
                void run(() =>
                  save({ type: "CLEAR_HANDOFF", input: { item_id } }),
                )
              }
            >
              Clear handoff
            </button>
          </div>
        )}
        <div className="inline-actions inspector-actions">
          {terminal ? (
            <button
              type="button"
              className="primary"
              disabled={disabled}
              onClick={() => {
                setReason("");
                setAction("reopen");
              }}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={disabled}
              onClick={() =>
                void run(() =>
                  save({
                    type: "SET_STATUS",
                    input: { item_id, status: "done" },
                  }),
                )
              }
            >
              Mark done
            </button>
          )}
          <button
            type="button"
            className="subtle"
            disabled={disabled}
            onClick={() => {
              setReason(item.handoff_note ?? "");
              setAction("handoff");
            }}
          >
            {item.handoff ? "Edit handoff" : "Flag handoff"}
          </button>
          {item.parent_id === null && (
            <button
              type="button"
              className="subtle"
              disabled={disabled}
              onClick={() => void run(() => update({ hidden: !item.hidden }))}
            >
              {item.hidden ? "Unhide" : "Hide"}
            </button>
          )}
          <button
            type="button"
            className="subtle danger"
            disabled={disabled}
            onClick={() => {
              if (
                !window.confirm(`Delete “${item.title}” and any child items?`)
              )
                return;
              void run(async () => {
                await save({ type: "DELETE_ITEM", input: { item_id } });
                close();
              });
            }}
          >
            Delete
          </button>
        </div>
        {action && (
          <form
            className="form-stack action-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = reason.trim();
              if (!value) return;
              void run(async () => {
                await save(
                  action === "reopen"
                    ? { type: "REOPEN_ITEM", input: { item_id, reason: value } }
                    : { type: "FLAG_HANDOFF", input: { item_id, note: value } },
                );
                setAction(undefined);
              });
            }}
          >
            <label className="form-field">
              {action === "reopen"
                ? "Reason for reopening"
                : "What input do you need?"}
              <textarea
                required
                rows={2}
                value={reason}
                disabled={disabled}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="inline-actions">
              <button className="primary" disabled={disabled || !reason.trim()}>
                {action === "reopen" ? "Reopen item" : "Save handoff"}
              </button>
              <button
                type="button"
                className="subtle"
                disabled={busy}
                onClick={() => setAction(undefined)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        <section className="inspector-section">
          <h3>Details</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (dirty) void saveDetails();
            }}
          >
            <fieldset className="form-stack" disabled={disabled}>
              <div className="form-grid">
                <label className="form-field">
                  Project
                  {item.parent_id ? (
                    <input value={project?.name ?? item.project_id} readOnly />
                  ) : (
                    <select
                      value={draft.project}
                      onChange={(event) => edit("project", event.target.value)}
                    >
                      <ProjectOptions projects={projects} />
                    </select>
                  )}
                </label>
                <label className="form-field">
                  Priority
                  <select
                    value={draft.priority}
                    onChange={(event) =>
                      edit("priority", Number(event.target.value))
                    }
                  >
                    {Array.from({ length: 10 }, (_, index) => (
                      <option key={index} value={index + 1}>
                        {index + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  Schedule
                  <input
                    type="date"
                    value={draft.schedule}
                    onChange={(event) => edit("schedule", event.target.value)}
                  />
                  {inherited && (
                    <small className="muted">Inherited · {inherited}</small>
                  )}
                </label>
                <TimeFields
                  type={draft.timeType}
                  setType={(type) => edit("timeType", type)}
                  at={draft.timeAt}
                  setAt={(at) => edit("timeAt", at)}
                  timezone={timezone}
                />
              </div>
              <label className="form-field">
                Tags
                <input
                  value={draft.tags}
                  placeholder="Comma-separated tags"
                  onChange={(event) => edit("tags", event.target.value)}
                />
              </label>
              <label className="form-field">
                Link
                <input
                  type="url"
                  value={draft.link}
                  placeholder="https://"
                  onChange={(event) => edit("link", event.target.value)}
                />
              </label>
              {(dirty || link) && (
                <div className="inline-actions">
                  {dirty && <button className="subtle">Save details</button>}
                  {link && (
                    <a href={link} target="_blank" rel="noreferrer">
                      Open link ↗
                    </a>
                  )}
                </div>
              )}
            </fieldset>
          </form>
          {locks.length > 0 && (
            <ul className="compact-list locks">
              {locks.map((field) => (
                <li key={field}>
                  <span className="status-pill lock-status">
                    {lockLabels[field]} locked
                  </span>
                  <button
                    type="button"
                    className="subtle"
                    aria-label={`Unlock ${lockLabels[field].toLowerCase()}`}
                    disabled={disabled}
                    onClick={() => void run(() => update({ unlock: field }))}
                  >
                    Unlock
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="form-stack note-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (note === undefined) return;
              void run(async () => {
                await save({
                  type: "SET_NOTE",
                  input: { item_id, note: note.trim() || null },
                });
                setNote(undefined);
              });
            }}
          >
            <label className="form-field">
              Note
              <textarea
                rows={2}
                value={note ?? item.note ?? ""}
                disabled={disabled}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            {note !== undefined && note !== (item.note ?? "") && (
              <div>
                <button className="subtle" disabled={disabled}>
                  Save note
                </button>
              </div>
            )}
          </form>
        </section>
        <section className="inspector-section">
          <h3>Dependencies</h3>
          {blockers.length ? (
            <ul className="compact-list">
              {blockers.map(({ blocked_by_id }) => (
                <li key={blocked_by_id}>
                  <span>
                    {items.get(blocked_by_id)?.title ??
                      `Archived item · ${blocked_by_id}`}
                  </span>
                  <button
                    type="button"
                    className="subtle"
                    disabled={disabled}
                    onClick={() =>
                      void run(() =>
                        save({
                          type: "SET_DEPENDENCY",
                          input: { item_id, blocked_by_id, action: "remove" },
                        }),
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No dependencies.</p>
          )}
          <form
            className="inline-actions dependency-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!target) return;
              void run(async () => {
                await save({
                  type: "SET_DEPENDENCY",
                  input: { item_id, blocked_by_id: target, action: "add" },
                });
                setTarget("");
              });
            }}
          >
            <select
              aria-label="Blocked by"
              value={target}
              disabled={disabled || !choices.length}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">Choose a blocking item</option>
              {choices.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
            </select>
            <button
              className="subtle"
              disabled={disabled || !choices.some(({ id }) => id === target)}
            >
              Add dependency
            </button>
          </form>
        </section>
        <section className="inspector-section">
          <h3>Child items</h3>
          {item.depth === 3 ? (
            <p className="muted">{depthLimitMessage}</p>
          ) : (
            <button
              type="button"
              className="subtle"
              disabled={disabled}
              onClick={addChild}
            >
              Add child item
            </button>
          )}
        </section>
        <Activity item={item} timezone={timezone} />
      </div>
    </aside>
  );
}
