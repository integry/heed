import { HandoffReply } from "./HandoffReply";
import { latestVerdict, safeLink, verdictMatches } from "./SelectedItem";
import { useResource, type Resource } from "./api";
import { useEffect, useRef, useState } from "react";
import {
  classifyJudgeProbability,
  JudgeFeedbackDetailSchema,
  LockableFieldSchema,
  UpdateItemSchema,
} from "@heedwork/core";
import type { LockableField, UpdateItemInput } from "@heedwork/core";
import { effectiveSchedule, progress, streamOrder } from "@heedwork/core";
import type {
  CanvasItem,
  Dependency,
  JudgedDetail,
  Event,
  Item,
  Project,
  TimeType,
} from "@heedwork/core";
import { depthLimitMessage } from "./QuickAdd";
import {
  dateLabel,
  ProjectOptions,
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
  acceptance: "Acceptance criteria",
};

function eventSummary(event: Event, detail: Record<string, unknown> | null) {
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
    case "answered":
      return `Answered handoff · ${detail?.text ?? ""}`;
    case "reopened":
      return detail?.reason ? `Reopened · ${detail.reason}` : "Reopened";
    case "moved":
      return "Updated placement";
    case "notified":
      return "Sent a notification";
    case "judged":
      return "Shadow verdict";
    case "judge_feedback":
      return detail?.agrees
        ? "Agreed with shadow verdict"
        : "Disagreed with shadow verdict";
  }
}

const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 2,
});

function VerdictScore({ probability }: { probability: number | null }) {
  return (
    <span className="verdict-score">
      {classifyJudgeProbability(probability)} ·{" "}
      {probability === null ? "No probability" : percent.format(probability)}
    </span>
  );
}

function ShadowVerdict({
  event,
  detail,
  matches,
  events,
  live,
  save,
}: {
  event: Event;
  detail: JudgedDetail;
  matches: boolean;
  events: Event[];
  live: boolean;
  save: SaveMutation;
}) {
  const { run, busy, error } = useAction();
  const { criteria, probabilities, model, evidence_supplied } = detail;
  let feedback: { id: number; agrees: boolean } | undefined;
  for (const entry of events) {
    if (
      entry.kind !== "judge_feedback" ||
      (feedback && entry.id <= feedback.id)
    )
      continue;
    const parsed = JudgeFeedbackDetailSchema.safeParse(
      JSON.parse(entry.detail ?? "null"),
    );
    if (parsed.success && parsed.data.judged_event_id === event.id)
      feedback = { id: entry.id, agrees: parsed.data.agrees };
  }

  return (
    <section
      className="shadow-verdict form-stack"
      aria-labelledby="shadow-verdict-heading"
    >
      <h4 id="shadow-verdict-heading">Shadow verdict</h4>
      {!matches && (
        <>
          <p className="muted">Judged against earlier criteria</p>
          <ul className="acceptance-list">
            {criteria.map((criterion, index) => (
              <li key={index}>
                <span>{criterion}</span>
                <VerdictScore probability={probabilities[index]} />
              </li>
            ))}
          </ul>
        </>
      )}
      <small className="muted">
        {model} ·{" "}
        {evidence_supplied ? "Evidence supplied" : "No evidence supplied"}
      </small>
      <div className="inline-actions">
        <span className="muted">Advisory only</span>
        {[true, false].map((agrees) => (
          <button
            key={String(agrees)}
            type="button"
            className={feedback?.agrees === agrees ? "primary" : "subtle"}
            aria-pressed={feedback?.agrees === agrees}
            disabled={!live || busy}
            onClick={() => {
              if (feedback?.agrees === agrees) return;
              void run(() =>
                save(
                  {
                    type: "JUDGE_FEEDBACK",
                    input: {
                      item_id: event.item_id,
                      judged_event_id: event.id,
                      agrees,
                    },
                  },
                  { callerReportsError: true },
                ),
              );
            }}
          >
            {agrees ? "Agree" : "Disagree"}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function Activity({
  resource,
  timezone,
}: {
  resource: Resource<Event[]>;
  timezone: string;
}) {
  const { data, error, reload } = resource;
  const events = Array.isArray(data) ? data : undefined;
  const message =
    error?.message ??
    (data !== undefined && !events ? "Couldn’t load activity." : "");

  return (
    <section className="inspector-section">
      <h3>Activity</h3>
      {message ? (
        <div className="inline-actions">
          <p role="alert">{message}</p>
          <button type="button" className="subtle" onClick={reload}>
            Retry
          </button>
        </div>
      ) : !events ? (
        <p className="muted">Loading activity…</p>
      ) : events.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <ol className="activity-list">
          {events.map((event) => {
            const detail = JSON.parse(event.detail ?? "null");
            const evidence =
              event.kind === "status" &&
              detail?.new === "done" &&
              typeof detail.evidence === "string"
                ? detail.evidence
                : undefined;
            return (
              <li key={event.id}>
                <span>{eventSummary(event, detail)}</span>
                {evidence && (
                  <details className="activity-evidence">
                    <summary>Evidence</summary>
                    <pre tabIndex={0}>{evidence}</pre>
                  </details>
                )}
                <small>
                  {typeof event.actor === "string"
                    ? event.actor
                    : event.actor.name || event.actor.email}{" "}
                  · <time>{dateLabel(event.at, timezone)}</time>
                </small>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function LockMark({ field }: { field: LockableField }) {
  const label = `${lockLabels[field]} locked`;
  return (
    <span className="lock-mark" role="img" aria-label={label} title={label} />
  );
}

function AcceptanceCriteria({
  item,
  disabled,
  locked,
  events,
  save,
}: {
  item: Item;
  disabled: boolean;
  locked: boolean;
  events: Event[];
  save: SaveMutation;
}) {
  const [draft, setDraft] = useState<{
    original: string;
    index: number;
    value: string;
  }>();
  const { run, busy, error } = useAction();
  const stored = JSON.parse(item.acceptance) as string[];
  const latest = latestVerdict(events);
  const matches = latest && verdictMatches(latest.detail, stored);
  const unavailable = disabled || busy;
  const conflict = Boolean(
    draft && !busy && draft.original !== item.acceptance,
  );
  const edited = [...stored];
  if (draft) edited[draft.index] = draft.value.trim();
  const validation =
    draft && draft.value.trim() && !conflict
      ? UpdateItemSchema.safeParse({ item_id: item.id, acceptance: edited })
      : undefined;
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const returnFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!draft && returnFocus.current !== undefined) {
      (
        buttons.current.get(returnFocus.current) ?? buttons.current.get(-1)
      )?.focus();
      returnFocus.current = undefined;
    }
  }, [draft]);

  function finish() {
    returnFocus.current = draft?.index;
    setDraft(undefined);
  }

  function persist(acceptance: string[]) {
    const input = UpdateItemSchema.parse({ item_id: item.id, acceptance });
    return save({ type: "UPDATE_ITEM", input }, { callerReportsError: true });
  }

  function submit() {
    if (!draft || unavailable || !validation?.success) return;
    if (edited[draft.index] === stored[draft.index]) {
      finish();
      return;
    }
    void run(async () => {
      await persist(edited);
      finish();
    });
  }

  function editor(index: number) {
    if (draft?.index !== index) return null;
    return (
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          autoFocus
          aria-label={`Criterion ${index + 1}`}
          rows={2}
          required
          value={draft.value}
          disabled={unavailable}
          onChange={(event) =>
            setDraft({ ...draft, value: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              if (!busy) finish();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="inline-actions">
          <button
            className="subtle"
            disabled={unavailable || !validation?.success}
          >
            Save criterion
          </button>
          <button
            type="button"
            className="subtle"
            disabled={busy}
            onClick={finish}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  function start(index: number, value: string) {
    setDraft({ original: item.acceptance, index, value });
  }

  function focusRef(index: number) {
    return (button: HTMLButtonElement | null) => {
      if (button) buttons.current.set(index, button);
      else buttons.current.delete(index);
    };
  }

  return (
    <section className="inspector-section" aria-labelledby="acceptance-heading">
      <h3 id="acceptance-heading">
        Acceptance criteria {locked && <LockMark field="acceptance" />}
      </h3>
      {stored.length === 0 ? (
        <p className="muted">No acceptance criteria yet.</p>
      ) : (
        <ol className="acceptance-list">
          {stored.map((criterion, index) => (
            <li key={index}>
              {draft?.index === index ? (
                editor(index)
              ) : (
                <button
                  type="button"
                  className="inline-edit criterion-text"
                  ref={focusRef(index)}
                  disabled={unavailable || Boolean(draft)}
                  onClick={() => start(index, criterion)}
                >
                  {criterion}
                </button>
              )}
              {matches && (
                <VerdictScore
                  probability={latest.detail.probabilities[index]}
                />
              )}
              {draft?.index !== index && (
                <button
                  type="button"
                  className="criterion-remove subtle"
                  aria-label={`Remove criterion ${index + 1}`}
                  disabled={unavailable || Boolean(draft)}
                  onClick={() =>
                    void run(() =>
                      persist(stored.filter((_, i) => i !== index)),
                    )
                  }
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {draft && draft.index >= stored.length ? (
        editor(draft.index)
      ) : (
        <button
          type="button"
          className="subtle criterion-add"
          ref={focusRef(-1)}
          disabled={unavailable || Boolean(draft) || stored.length >= 8}
          onClick={() => start(stored.length, "")}
        >
          Add criterion
        </button>
      )}
      {conflict && (
        <p role="alert">
          Criteria changed elsewhere. Cancel to load the latest version.
        </p>
      )}
      {validation && !validation.success && (
        <p className="muted">{validation.error.issues[0].message}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {latest && (
        <ShadowVerdict
          key={latest.event.id}
          event={latest.event}
          detail={latest.detail}
          matches={Boolean(matches)}
          events={events}
          live={!disabled}
          save={save}
        />
      )}
    </section>
  );
}

type DetailDraft = {
  project: string;
  priority: number;
  schedule: string;
  timeType: TimeType;
  timeAt: string;
  link: string;
};

export function Inspector({
  drawer,
  activityRevision,
  item,
  projects,
  items,
  dependencies,
  timezone,
  live,
  save,
  close,
  addChild,
  openDependencies,
  selectChild,
}: {
  drawer: boolean;
  activityRevision: string;
  item: Item | CanvasItem;
  projects: readonly Project[];
  items: ReadonlyMap<string, Item>;
  dependencies: readonly Dependency[];
  timezone: string;
  live: boolean;
  save: SaveMutation;
  close: () => void;
  addChild: () => void;
  openDependencies?: () => void;
  selectChild?: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (drawer) dialog.current?.showModal();
  }, [drawer]);
  const [title, setTitle] = useState<string>();
  const titleButton = useRef<HTMLButtonElement>(null);
  const restoreTitleFocus = useRef(false);
  useEffect(() => {
    if (title === undefined && restoreTitleFocus.current) {
      titleButton.current?.focus();
      restoreTitleFocus.current = false;
    }
  }, [title]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [note, setNote] = useState<string>();
  const [details, setDetails] = useState<Partial<DetailDraft>>({});
  const [tagDraft, setTagDraft] = useState<{
    original: string;
    values: string[];
  }>();
  const [newTag, setNewTag] = useState("");
  const [action, setAction] = useState<"handoff" | "reopen">();
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const { run, error, busy } = useAction();
  const children = selectChild
    ? streamOrder(
        [...items.values()].filter(
          (candidate) =>
            candidate.parent_id === item.id && candidate.status !== "cancelled",
        ),
      )
    : [];
  const { done, total } =
    "progress" in item ? item.progress : progress(item, [...items.values()]);
  const activity = useResource<Event[]>(
    `/api/items/${encodeURIComponent(item.id)}/events`,
    JSON.stringify([
      activityRevision,
      item.status,
      item.completed_at,
      item.note,
      item.handoff,
      item.handoff_note,
      item.handoff_answered_at,
      item.reopen_count,
      item.scheduled_on,
      item.project_id,
      item.parent_id,
    ]),
  );
  const baseline: DetailDraft = {
    project: item.project_id,
    priority: item.priority,
    schedule: item.scheduled_on ?? "",
    timeType: item.time_type,
    timeAt: timeInputValue(item.time_at, timezone),
    link: item.ref_url ?? "",
  };
  const draft = { ...baseline, ...details };
  const storedTags = JSON.parse(item.tags) as string[];
  const tagValues = tagDraft?.values ?? storedTags;
  const pendingTag = newTag.trim();
  const tags = pendingTag ? [...tagValues, pendingTag] : tagValues;
  const tagsChanged = JSON.stringify(tags) !== JSON.stringify(storedTags);
  const tagConflict =
    tagsChanged && tagDraft && tagDraft.original !== item.tags;
  const dirty =
    tagsChanged ||
    (Object.keys(details) as (keyof DetailDraft)[]).some(
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

  function editTags(values: string[]) {
    setTagDraft((previous) =>
      JSON.stringify(values) === JSON.stringify(storedTags)
        ? undefined
        : { original: previous?.original ?? item.tags, values },
    );
  }

  function addTag() {
    if (!pendingTag) return;
    editTags(tags);
    setNewTag("");
  }

  function finishTitle() {
    restoreTitleFocus.current = true;
    setTitle(undefined);
  }

  function submitTitle() {
    const value = title?.trim();
    if (disabled || !value) return;
    if (value === item.title) {
      finishTitle();
      return;
    }
    void run(async () => {
      await update({ title: value });
      finishTitle();
    });
  }

  function saveDetails() {
    return run(async () => {
      const patch: Omit<UpdateItemInput, "item_id"> = {};
      if (draft.project !== baseline.project) patch.project = draft.project;
      if (draft.priority !== baseline.priority) patch.priority = draft.priority;
      if (draft.schedule !== baseline.schedule)
        patch.scheduled_on = draft.schedule || null;
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
      if (tagsChanged) {
        patch.tags = tags;
        // Keep the submitted list in the draft while waiting for confirmation.
        editTags(tags);
        setNewTag("");
      }
      await update(patch);
      setDetails({});
      setTagDraft(undefined);
    });
  }

  const content = (
    <>
      <header className="panel-heading inspector-heading">
        <h2 id="inspector-heading">Inspector</h2>
        <button type="button" className="subtle" onClick={close}>
          Close
        </button>
      </header>
      <div className="inspector-body">
        {title === undefined ? (
          <h3 className="inspector-title" aria-label={item.title}>
            <button
              type="button"
              className="inline-edit"
              ref={titleButton}
              aria-label={`${item.title} — edit title`}
              disabled={disabled}
              onClick={() => setTitle(item.title)}
            >
              {item.title}
            </button>
          </h3>
        ) : (
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submitTitle();
            }}
          >
            <input
              autoFocus
              aria-label="Title"
              required
              value={title}
              disabled={disabled}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (!busy) finishTitle();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  submitTitle();
                }
              }}
            />
            <div className="inline-actions">
              <button className="subtle" disabled={disabled || !title.trim()}>
                Save title
              </button>
              <button
                type="button"
                className="subtle"
                disabled={busy}
                onClick={finishTitle}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
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
        <div className="inspector-note">
          <h4>Latest note</h4>
          {note !== undefined ? (
            <form
              className="form-stack note-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (disabled || note === (item.note ?? "")) return;
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
                  autoFocus
                  rows={2}
                  value={note}
                  disabled={disabled}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <div className="inline-actions">
                <button
                  className="subtle"
                  disabled={disabled || note === (item.note ?? "")}
                >
                  Save note
                </button>
                <button
                  type="button"
                  className="subtle"
                  disabled={busy}
                  onClick={() => setNote(undefined)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              {item.note && <p>{item.note}</p>}
              <button
                type="button"
                className="inline-edit muted"
                disabled={disabled}
                onClick={() => setNote(item.note ?? "")}
              >
                {item.note ? "Edit note" : "Add note"}
              </button>
            </>
          )}
        </div>
        {link && (
          <a href={link} target="_blank" rel="noreferrer">
            Open link ↗
          </a>
        )}
        <AcceptanceCriteria
          item={item}
          disabled={disabled}
          locked={locks.includes("acceptance")}
          events={Array.isArray(activity.data) ? activity.data : []}
          save={save}
        />
        {item.handoff === 1 && (
          <div className="handoff-card">
            <HandoffReply
              item={item}
              disabled={disabled || terminal}
              save={save}
            />
            <button
              type="button"
              className="subtle"
              disabled={disabled}
              onClick={() => {
                setReason(item.handoff_note ?? "");
                setAction("handoff");
              }}
            >
              Edit handoff
            </button>
          </div>
        )}
        {item.handoff_answer != null && (
          <div className="handoff-card">
            <strong>Handoff answered</strong>
            {item.handoff_note && <p>{item.handoff_note}</p>}
            <p>{item.handoff_answer}</p>
          </div>
        )}
        <section className="inspector-section">
          <h3>Child progress</h3>
          <p className="muted">
            {total ? `${done} of ${total} complete` : "No child items."}
          </p>
          {selectChild && children.length > 0 && (
            <ul className="item-list">
              {children.map(({ id, title }) => (
                <li key={id}>
                  <button
                    className="item-row"
                    type="button"
                    onClick={() => selectChild(id)}
                  >
                    <span className="item-title">{title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {openDependencies && (
            <button type="button" className="subtle" onClick={openDependencies}>
              Open dependency graph
            </button>
          )}
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
        <section className="inspector-section">
          <div className="inspector-facts muted">
            <span>{project?.name ?? item.project_id}</span>
            <span>
              Priority {item.priority}{" "}
              {locks.includes("priority") && <LockMark field="priority" />}
            </span>
            <span>
              {effectiveSchedule(item, items) ?? "Unscheduled"}{" "}
              {locks.includes("scheduled_on") && (
                <LockMark field="scheduled_on" />
              )}
            </span>
            {item.time_type !== "flexible" && item.time_at && (
              <span>
                {item.time_type === "deadline" ? "Due" : "Fixed"}{" "}
                {dateLabel(item.time_at, timezone)}
              </span>
            )}
            {storedTags.length > 0 && (
              <span>Tags · {storedTags.join(", ")}</span>
            )}
            {blockers.length > 0 && (
              <span>
                Blocked by ·{" "}
                {blockers
                  .map(
                    ({ blocked_by_id }) =>
                      items.get(blocked_by_id)?.title ?? blocked_by_id,
                  )
                  .join(", ")}
              </span>
            )}
            {locks.includes("sort_key") && (
              <span>
                Stream order <LockMark field="sort_key" />
              </span>
            )}
            {locks.includes("layout_pos") && (
              <span>
                Canvas position <LockMark field="layout_pos" />
              </span>
            )}
          </div>
          <details className="inspector-details" open={detailsOpen}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                setDetailsOpen(!detailsOpen);
              }}
            >
              Edit details
            </summary>
            {detailsOpen && (
              <div className="form-stack inspector-detail-editors">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (dirty && !disabled && !tagConflict) void saveDetails();
                  }}
                >
                  <fieldset className="form-stack" disabled={disabled}>
                    <div className="form-grid">
                      <label className="form-field">
                        Project
                        {item.parent_id ? (
                          <input
                            value={project?.name ?? item.project_id}
                            readOnly
                          />
                        ) : (
                          <select
                            value={draft.project}
                            onChange={(event) =>
                              edit("project", event.target.value)
                            }
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
                          onChange={(event) =>
                            edit("schedule", event.target.value)
                          }
                        />
                        {inherited && (
                          <small className="muted">
                            Inherited · {inherited}
                          </small>
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
                    <fieldset className="inspector-tags" disabled={tagConflict}>
                      <legend className="form-field">Tags</legend>
                      {tagValues.length > 0 && (
                        <ul className="compact-list">
                          {tagValues.map((tag, index) => (
                            <li key={index}>
                              <span>{tag || "(Empty tag)"}</span>
                              <button
                                type="button"
                                className="subtle"
                                aria-label={
                                  tag ? `Remove tag ${tag}` : "Remove empty tag"
                                }
                                onClick={() =>
                                  editTags(
                                    tagValues.filter(
                                      (_, position) => position !== index,
                                    ),
                                  )
                                }
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="tag-input">
                        <label className="form-field">
                          New tag
                          <input
                            value={newTag}
                            onChange={(event) => setNewTag(event.target.value)}
                            onKeyDown={(event) => {
                              if (
                                event.key !== "Enter" ||
                                event.nativeEvent.isComposing
                              )
                                return;
                              event.preventDefault();
                              addTag();
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="subtle"
                          disabled={!pendingTag}
                          onClick={addTag}
                        >
                          Add tag
                        </button>
                      </div>
                    </fieldset>
                    {tagConflict && (
                      <div className="inline-actions">
                        <p role="alert">
                          Tags changed elsewhere. Reload tags to edit the
                          current list.
                        </p>
                        <button
                          type="button"
                          className="subtle"
                          onClick={() => {
                            setTagDraft(undefined);
                            setNewTag("");
                          }}
                        >
                          Reload tags
                        </button>
                      </div>
                    )}
                    <label className="form-field">
                      Link
                      <input
                        type="url"
                        value={draft.link}
                        placeholder="https://"
                        onChange={(event) => edit("link", event.target.value)}
                      />
                    </label>
                    {dirty && (
                      <div>
                        <button className="subtle" disabled={tagConflict}>
                          Save details
                        </button>
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
                          onClick={() =>
                            void run(() => update({ unlock: field }))
                          }
                        >
                          Unlock
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
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
                                input: {
                                  item_id,
                                  blocked_by_id,
                                  action: "remove",
                                },
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
                        input: {
                          item_id,
                          blocked_by_id: target,
                          action: "add",
                        },
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
                    disabled={
                      disabled || !choices.some(({ id }) => id === target)
                    }
                  >
                    Add dependency
                  </button>
                </form>
              </div>
            )}
          </details>
        </section>
        <Activity resource={activity} timezone={timezone} />
      </div>
      <footer className="inspector-footer">
        {error && (
          <p className="action-error" role="alert">
            {error}
          </p>
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
              if (item.handoff) {
                void run(() =>
                  save({ type: "CLEAR_HANDOFF", input: { item_id } }),
                );
              } else {
                setReason("");
                setAction("handoff");
              }
            }}
          >
            {item.handoff ? "Clear handoff" : "Flag handoff"}
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
      </footer>
    </>
  );
  return drawer ? (
    <dialog
      ref={dialog}
      className="inspector inspector-drawer"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientY < bounds.top) close();
        }
      }}
      aria-labelledby="inspector-heading"
    >
      {content}
    </dialog>
  ) : (
    <aside className="inspector" aria-labelledby="inspector-heading">
      {content}
    </aside>
  );
}
