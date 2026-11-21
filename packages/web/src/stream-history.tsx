import { DemoBadge } from "./item-markers";
import { GuideEmpty } from "./Onboarding";
import { useApi } from "./api";
import { useEffect, useRef, useState } from "react";
import {
  ReopenBodySchema,
  type HistoryItem,
  type HistoryPage,
} from "@heedwork/core";
import type { Project } from "@heedwork/core";

interface HistoryProps {
  projects: readonly Project[];
  timezone: string;
  demoLoaded?: boolean;
  openGuide?: () => void;
  live: boolean;
  openIds: ReadonlySet<string>;
  pendingIds: ReadonlySet<string>;
  reopen: (id: string, reason: string) => boolean;
  close: () => void;
}

function HistoryRow({
  item,
  project,
  timezone,
  live,
  pending,
  reopen,
}: {
  item: HistoryItem;
  project?: string;
  timezone: string;
  live: boolean;
  pending: boolean;
  reopen: HistoryProps["reopen"];
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const valid = ReopenBodySchema.safeParse({ reason: reason.trim() }).success;
  const date = new Date(item.history_at);
  return (
    <li className="history-row">
      <div className="history-row-heading">
        <div>
          <p className="item-title">{item.title}</p>
          <p className="stream-meta">
            {project && <span>{project}</span>}
            {item.demo === 1 && <DemoBadge />}
            <span>{item.status === "done" ? "Done" : "Cancelled"}</span>
            <time dateTime={item.history_at}>
              {date.toLocaleDateString(undefined, {
                dateStyle: "medium",
                timeZone: timezone,
              })}
            </time>
          </p>
        </div>
        {!editing && (
          <button
            className="subtle"
            type="button"
            onClick={() => setEditing(true)}
          >
            Reopen
          </button>
        )}
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && live && !pending) reopen(item.id, reason.trim());
          }}
        >
          <label>
            Reason for reopening
            <textarea
              rows={2}
              value={reason}
              required
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button
              className="subtle"
              type="button"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button className="primary" disabled={!valid || !live || pending}>
              {pending ? "Reopening…" : "Reopen item"}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function HistoryResults({
  query,
  project,
  projects,
  timezone,
  live,
  openIds,
  pendingIds,
  openGuide,
  reopen,
}: Omit<HistoryProps, "close"> & { query: string; project: string }) {
  const { getJson } = useApi();
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [request, setRequest] = useState<{ before?: string }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const more = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (project) params.set("project", project);
    if (request.before) params.set("before", request.before);
    async function load() {
      try {
        const next = await getJson<HistoryPage>(
          `/api/history?${params}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setPage((previous) => {
          const items = new Map(previous?.items.map((item) => [item.id, item]));
          for (const item of next.items) items.set(item.id, item);
          return {
            items: [...items.values()],
            next_before:
              next.next_before === request.before ? null : next.next_before,
          };
        });
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [getJson, project, query, request]);

  useEffect(() => {
    const button = more.current;
    if (
      !button ||
      loading ||
      error ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect();
        button.click();
      }
    });
    observer.observe(button);
    return () => observer.disconnect();
  }, [page, loading, error]);

  function loadMore(before?: string) {
    setError(false);
    setLoading(true);
    setRequest({ before });
  }

  const rows = page?.items.filter((item) => !openIds.has(item.id)) ?? [];
  return (
    <div className="history-results">
      <ul className="item-list">
        {rows.map((item) => (
          <HistoryRow
            key={item.id}
            item={item}
            project={projects.find(({ id }) => id === item.project_id)?.name}
            timezone={timezone}
            live={live}
            pending={pendingIds.has(item.id)}
            reopen={reopen}
          />
        ))}
      </ul>
      {loading && (
        <p className="stream-empty" role="status">
          Loading history…
        </p>
      )}
      {error && (
        <div className="stream-empty">
          <p role="alert">Couldn’t load history.</p>
          <button
            type="button"
            className="subtle"
            onClick={() => loadMore(request.before)}
          >
            Retry
          </button>
        </div>
      )}
      {!loading && !error && rows.length === 0 && !page?.next_before && (
        <GuideEmpty className="stream-empty" openGuide={openGuide}>
          {query || project
            ? "No history matches these filters."
            : "No completed or cancelled items yet."}
        </GuideEmpty>
      )}
      {!loading && !error && page?.next_before && (
        <button
          type="button"
          className="subtle"
          ref={more}
          onClick={() => loadMore(page.next_before!)}
        >
          Load more
        </button>
      )}
    </div>
  );
}

export function StreamHistory({ close, ...props }: HistoryProps) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [projectId, setProject] = useState("");
  const project = props.projects.some(({ id }) => id === projectId)
    ? projectId
    : "";
  return (
    <>
      <div className="section-heading stream-heading">
        <h2 id="stream-heading">History</h2>
        <button className="subtle" type="button" onClick={close}>
          Back to stream
        </button>
      </div>
      <form
        className="history-filters"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <label>
          Search history
          <input
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button className="subtle" type="submit">
          Search
        </button>
        <label>
          Project
          <select
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">All projects</option>
            {props.projects.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </form>
      <HistoryResults
        key={JSON.stringify([query, project, props.demoLoaded])}
        query={query}
        project={project}
        {...props}
      />
    </>
  );
}
