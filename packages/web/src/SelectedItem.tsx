import {
  classifyJudgeProbability,
  JudgedDetailSchema,
  type Event,
  type Item,
} from "@heedwork/core";
import type { Resource } from "./api";

export function safeLink(value: string) {
  const url = URL.parse(value);
  return url && (url.protocol === "https:" || url.protocol === "http:")
    ? url.href
    : undefined;
}

export function latestVerdict(events: Event[], completionId?: number) {
  for (const event of events) {
    if (event.kind !== "judged") continue;
    const detail = JudgedDetailSchema.safeParse(
      JSON.parse(event.detail ?? "null"),
    ).data;
    if (completionId === undefined || detail?.status_event_id === completionId)
      return detail ? { event, detail } : undefined;
  }
}

export function verdictMatches(
  verdict: { criteria: string[] },
  criteria: string[],
) {
  return (
    verdict.criteria.length === criteria.length &&
    criteria.every((criterion, index) => verdict.criteria[index] === criterion)
  );
}

export function SelectedItem({
  item,
  activity,
  openGraph,
  close,
}: {
  item: Item;
  activity: Resource<Event[]>;
  openGraph?: () => void;
  close: () => void;
}) {
  const criteria = JSON.parse(item.acceptance) as string[];
  const { data, loading } = activity;
  // The item and its activity arrive independently. Use the status event only
  // once the activity has caught up with the selected item's completion.
  const events = !loading && Array.isArray(data) ? data : [];
  const completion = events.find(({ kind }) => kind === "status");
  const latest =
    completion &&
    completion.at === item.completed_at &&
    JSON.parse(completion.detail ?? "null")?.new === "done"
      ? latestVerdict(events, completion.id)?.detail
      : undefined;
  const verdict =
    latest && verdictMatches(latest, criteria) ? latest : undefined;
  const link = item.ref_url && safeLink(item.ref_url);
  return (
    <section className="selected-summary" aria-label="Selected item">
      <div className="selected-heading">
        <h2>{item.title}</h2>
        <button
          className="text-control"
          type="button"
          aria-label="Clear selection"
          onClick={close}
        >
          ×
        </button>
      </div>
      <p className="selected-owner">
        {item.agent_name ?? (item.created_by === "human" ? "you" : "Agent")}
      </p>
      {item.note && <p className="selected-note">{item.note}</p>}
      {criteria.length > 0 && (
        <ul aria-label="Acceptance criteria">
          {criteria.map((criterion, index) => (
            <li key={index}>
              {criterion}
              {verdict && (
                <small>
                  {" "}
                  · {classifyJudgeProbability(verdict.probabilities[index])}
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="selected-actions">
        {link && (
          <a href={link} target="_blank" rel="noreferrer">
            Open link ↗
          </a>
        )}
        {openGraph && (
          <button className="text-control" type="button" onClick={openGraph}>
            Open dependency graph
          </button>
        )}
      </div>
    </section>
  );
}
