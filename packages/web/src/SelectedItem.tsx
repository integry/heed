import {
  classifyJudgeProbability,
  JudgedDetailSchema,
  type Event,
  type Item,
} from "@heedwork/core";
import { useResource } from "./api";

export function safeLink(value: string) {
  const url = URL.parse(value);
  return url && (url.protocol === "https:" || url.protocol === "http:")
    ? url.href
    : undefined;
}

export function latestVerdict(events: Event[]) {
  const event = events.find(({ kind }) => kind === "judged");
  const detail = event
    ? JudgedDetailSchema.safeParse(JSON.parse(event.detail ?? "null")).data
    : undefined;
  return event && detail ? { event, detail } : undefined;
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
  revision,
  inspect,
  close,
}: {
  item: Item;
  revision: string;
  inspect: () => void;
  close: () => void;
}) {
  const criteria = JSON.parse(item.acceptance) as string[];
  const { data } = useResource<Event[]>(
    criteria.length ? `/api/items/${encodeURIComponent(item.id)}/events` : null,
    revision,
  );
  const latest = Array.isArray(data) ? latestVerdict(data)?.detail : undefined;
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
      {item.handoff === 1 && item.handoff_note && (
        <p className="selected-note">{item.handoff_note}</p>
      )}
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
        <button className="text-control" type="button" onClick={inspect}>
          Open inspector
        </button>
      </div>
    </section>
  );
}
