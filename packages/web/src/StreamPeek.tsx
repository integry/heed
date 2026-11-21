import type { Band } from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import { ItemTimeBadge, itemTimeFormats } from "./item-markers";
import type { selectWorkspace } from "./workspace-view";

const upcomingBands = ["today", "tomorrow", "this-week", "later"] as const;

export function StreamPeek({
  bands,
  items,
  timezone,
  ready,
  selectedId,
  select,
}: Pick<ReturnType<typeof selectWorkspace>, "bands" | "timezone"> & {
  items: ReadonlyMap<string, CanvasItem>;
  ready: boolean;
  selectedId: string | null;
  select: (id: string) => void;
}) {
  const formats = itemTimeFormats(timezone);
  const entries: { band: Band; item: CanvasItem }[] = [];
  for (const band of upcomingBands) {
    for (const { item } of bands[band]) {
      entries.push({ band, item });
      if (entries.length === 2) break;
    }
    if (entries.length === 2) break;
  }

  return (
    <div className="stream-peek">
      <h2 className="sr-only">Horizon Stream</h2>
      {entries.map(({ band, item }, index) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={selectedId === item.id}
          onClick={() => select(item.id)}
        >
          <span className="peek-label">
            {index === 0 && band === "today" ? "Now" : "Next"}
          </span>
          <ItemTimeBadge
            item={item}
            items={items}
            formats={formats}
            upcoming={band !== "today"}
          />
          <span className="item-title">{item.title}</span>
          {item.handoff === 1 && <span className="stream-flag">Handoff</span>}
          {item.progress.total > 0 && (
            <span
              className="peek-progress"
              aria-label={`${item.progress.done} of ${item.progress.total} children complete`}
            >
              {item.progress.done}/{item.progress.total}
            </span>
          )}
        </button>
      ))}
      {ready && entries.length === 0 && <p>No upcoming items.</p>}
    </div>
  );
}
