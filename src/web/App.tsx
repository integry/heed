import {
  needsMeCount,
  STREAM_BANDS,
  streamRows,
  type Band,
  type StreamRow,
} from "../shared/derived-state";
import type { Item } from "../shared/workspace";

const bandLabels: Record<Band, string> = {
  "done-today": "Done today",
  today: "Today",
  tomorrow: "Tomorrow",
  "this-week": "This week",
  later: "Later",
  backlog: "Backlog",
};

function StreamList({ rows }: { rows: StreamRow[] }) {
  return (
    <ul>
      {rows.map(({ item, children }) => (
        <li key={item.id}>
          {children.length > 0 ? (
            <details open>
              <summary>{item.title}</summary>
              <StreamList rows={children} />
            </details>
          ) : (
            item.title
          )}
        </li>
      ))}
    </ul>
  );
}

interface CanvasProps {
  items: readonly Item[];
  now: number;
  timezone: string;
}

function HorizonStream({ items, now, timezone }: CanvasProps) {
  const rows = streamRows(items, now, timezone);
  return (
    <section aria-labelledby="horizon-stream" className="horizon-stream">
      <h2 id="horizon-stream">Horizon Stream</h2>
      <p>Needs me: {needsMeCount(items, now)}</p>
      {STREAM_BANDS.filter((band) => rows[band].length > 0).map((band) => (
        <section key={band}>
          <h3>{bandLabels[band]}</h3>
          <StreamList rows={rows[band]} />
        </section>
      ))}
    </section>
  );
}

export function App({ canvas }: { canvas?: CanvasProps }) {
  return (
    <main>
      <h1>Heed</h1>
      {canvas ? (
        <HorizonStream {...canvas} />
      ) : (
        <p>A workspace for human and agent work.</p>
      )}
    </main>
  );
}
