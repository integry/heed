import { memo, type PointerEvent } from "react";
import { workspaceInstant, type Ring } from "../shared/derived-state";
import type { CanvasItem } from "../shared/workspace-socket";
import { truncateLabel, type Point } from "./radar-geometry";

export interface Bubble {
  item: CanvasItem;
  point: Point;
  radius: number;
  scale: number;
  color: string;
  ring: Ring | null;
  rollup: Ring | null;
  opensGoal: boolean;
}

const statusLabels: Record<Ring, string> = {
  handoff: "Needs input",
  stale: "Stale",
  reopened: "Reopened",
  blocked: "Blocked",
  live: "Live",
};

export function lastSeen(timestamp: string | null, now: number) {
  const minutes = Math.floor((now - workspaceInstant(timestamp)) / 60_000);
  if (!Number.isFinite(minutes)) return "Last seen unknown";
  if (minutes < 60) return `Last seen ${Math.max(0, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `Last seen ${hours}h ago`
    : `Last seen ${Math.floor(hours / 24)}d ago`;
}

function titleLines(title: string, width: number, font: number) {
  const first = truncateLabel(title, width, font);
  if (first === title) return [first];
  const breakAt = first.lastIndexOf(" ");
  if (breakAt === -1) return [first];
  return [
    title.slice(0, breakAt),
    truncateLabel(title.slice(breakAt + 1), width, font),
  ];
}

export const RadarBubble = memo(function RadarBubble({
  bubble,
  selected,
  live,
  now,
  timeFormatter,
  onActivate,
  onGesture,
  onPriority,
  onTooltip,
}: {
  bubble: Bubble;
  selected: boolean;
  live: boolean;
  now: number;
  timeFormatter: Intl.DateTimeFormat;
  onActivate: (bubble: Bubble) => void;
  onGesture: (
    event: PointerEvent<SVGElement>,
    bubble: Bubble,
    kind: "move" | "resize",
  ) => void;
  onPriority: (id: string, priority: number) => void;
  onTooltip: (text: string | null) => void;
}) {
  const { item, point, radius, ring, rollup, opensGoal, color } = bubble;
  const ghost = item.status === "done";
  const showResize = selected && live && !ghost;
  const stale = ring === "stale" ? lastSeen(item.last_heartbeat_at, now) : null;
  const time = workspaceInstant(item.time_at);
  const badge =
    item.time_type !== "flexible" && Number.isFinite(time)
      ? `${item.time_type === "fixed" ? "Fixed" : "Due"} ${timeFormatter.format(time)}`
      : null;
  const { done, total } = item.progress;
  const stamp = badge ?? stale;
  const stampWidth = stamp ? Math.max(64, stamp.length * 4.3 + 12) : 0;
  const detail = [
    item.title,
    ghost ? "Completed" : ring && statusLabels[ring],
    stale,
    badge,
    rollup && `Descendants: ${statusLabels[rollup]}`,
    total > 0 && `${done} of ${total} complete`,
  ]
    .filter(Boolean)
    .join(" · ");
  const font = Math.min(15, Math.max(2.8, radius * 0.29));
  const lines = titleLines(item.title, radius * 1.78, font);
  const progressRadius = radius + (ring ? 5 : 2);
  const circumference = 2 * Math.PI * progressRadius;
  const handle = (radius + 6) / Math.SQRT2;

  return (
    <g className="radar-node" transform={`translate(${point.x},${point.y})`}>
      <g
        data-canvas-drag
        data-radar-bubble={item.id}
        className="radar-bubble"
        data-ghost={ghost}
        role="button"
        tabIndex={0}
        aria-label={item.title}
        aria-description={detail}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation();
          onActivate(bubble);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivate(bubble);
          }
        }}
        onPointerDown={(event) =>
          live && !ghost && onGesture(event, bubble, "move")
        }
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") onTooltip(detail);
        }}
        onPointerLeave={() => onTooltip(null)}
        onFocus={() => onTooltip(detail)}
        onBlur={() => onTooltip(null)}
      >
        <title>{detail}</title>
        {ring === "live" && <circle className="radar-pulse" r={radius + 3} />}
        {rollup && (
          <circle
            className="radar-state radar-rollup"
            data-ring={rollup}
            r={radius + (ring ? 9 : 6)}
          />
        )}
        {ring && (
          <circle className="radar-state" data-ring={ring} r={radius + 3} />
        )}
        <circle r={radius} className="radar-disc" stroke={color} />
        {selected && (
          <circle r={radius + (rollup ? 13 : 8)} className="radar-selection" />
        )}
        {total > 0 && (
          <>
            <circle r={progressRadius} className="radar-progress-track" />
            {done > 0 && (
              <circle
                r={progressRadius}
                className="radar-progress"
                strokeDasharray={`${(circumference * done) / total} ${circumference}`}
                transform="rotate(-90)"
              />
            )}
          </>
        )}
        <text
          textAnchor="middle"
          className="radar-bubble-title"
          data-small={radius < 16}
          fontSize={font}
          aria-hidden="true"
        >
          {lines.map((line, index) => (
            <tspan
              key={index}
              x={0}
              y={(index - (lines.length - 1) / 2) * font + (stamp ? -3 : 3)}
            >
              {line}
            </tspan>
          ))}
        </text>
        {stamp && radius >= 21 && (
          <g
            className="radar-time-badge"
            aria-hidden="true"
            transform={`translate(0,${radius - 1})`}
          >
            <rect
              x={-stampWidth / 2}
              y={-6}
              width={stampWidth}
              height={13}
              rx={5}
            />
            <text textAnchor="middle" y={3.5} fontSize={8.5}>
              {stamp}
            </text>
          </g>
        )}
        {opensGoal && !stamp && radius >= 17 && (
          <text
            className="radar-child-count"
            textAnchor="middle"
            y={radius * 0.68}
            fontSize={Math.max(8, font * 0.73)}
            aria-hidden="true"
          >
            {total > 0 ? `${done}/${total}` : "›"}
          </text>
        )}
      </g>
      {showResize && (
        <g
          className="radar-resize"
          data-canvas-drag
          data-radar-resize
          role="slider"
          tabIndex={0}
          aria-label={`Priority for ${item.title}`}
          aria-valuemin={1}
          aria-valuemax={10}
          aria-valuenow={item.priority}
          transform={`translate(${handle},${handle})`}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => onGesture(event, bubble, "resize")}
          onKeyDown={(event) => {
            const steps: Record<string, number> = {
              ArrowRight: 1,
              ArrowUp: 1,
              ArrowLeft: -1,
              ArrowDown: -1,
            };
            const priority =
              event.key === "Home"
                ? 1
                : event.key === "End"
                  ? 10
                  : item.priority + (steps[event.key] ?? 0);
            if (
              event.key === "Home" ||
              event.key === "End" ||
              event.key in steps
            ) {
              event.preventDefault();
              const next = Math.min(10, Math.max(1, priority));
              if (next !== item.priority) onPriority(item.id, next);
            }
          }}
        >
          <title>Drag to resize</title>
          <circle r={12} fill="transparent" />
          <circle className="radar-handle" r={5} />
        </g>
      )}
    </g>
  );
});
