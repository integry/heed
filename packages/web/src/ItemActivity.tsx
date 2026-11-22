import {
  classifyJudgeProbability,
  JudgeFeedbackDetailSchema,
  type Event,
  type Item,
  type JudgedDetail,
} from "@heedwork/core";
import { latestVerdict, verdictMatches } from "./SelectedItem";
import type { Resource } from "./api";
import { dateLabel, useAction, type SaveMutation } from "./workspace-controls";

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
    <section className="selected-activity">
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

export function ItemActivity({
  item,
  activity,
  timezone,
  live,
  save,
}: {
  item: Item;
  activity: Resource<Event[]>;
  timezone: string;
  live: boolean;
  save: SaveMutation;
}) {
  const events = Array.isArray(activity.data) ? activity.data : [];
  const verdict = latestVerdict(events);
  return (
    <>
      <Activity resource={activity} timezone={timezone} />
      {verdict && (
        <ShadowVerdict
          key={verdict.event.id}
          {...verdict}
          matches={verdictMatches(verdict.detail, JSON.parse(item.acceptance))}
          events={events}
          live={live}
          save={save}
        />
      )}
    </>
  );
}
