import { memo, type PointerEvent } from "react";
import type { SVGProps } from "react";
import type { ItemShape, ProjectColor } from "@heedwork/core";
import { shapePath, shapeTop } from "./radar-shapes";
import { workspaceInstant, type Ring } from "@heedwork/core";
import type { CanvasItem } from "@heedwork/core";
import { RADAR_LABEL_FONT, type Point } from "./radar-geometry";
import { bubbleLabel, radarTimeBadge, type OutsideLabel } from "./radar-labels";
import { ringLabels } from "./workspace-view";

export interface Bubble {
  item: CanvasItem;
  point: Point;
  radius: number;
  scale: number;
  ring: Ring | null;
  rollup: Ring | null;
  opensGoal: boolean;
}

export function lastSeen(timestamp: string | null, now: number) {
  const minutes = Math.floor((now - workspaceInstant(timestamp)) / 60_000);
  if (!Number.isFinite(minutes)) return "Last seen unknown";
  if (minutes < 60) return `Last seen ${Math.max(0, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `Last seen ${hours}h ago`
    : `Last seen ${Math.floor(hours / 24)}d ago`;
}

export function bubbleDetails(
  { item, ring, rollup }: Bubble,
  now: number,
  timeFormatter: Intl.DateTimeFormat,
) {
  const ghost = item.status === "done";
  const stale = ring === "stale" ? lastSeen(item.last_heartbeat_at, now) : null;
  const { badge, stamp } = radarTimeBadge(item, timeFormatter);
  const { done, total } = item.progress;
  const detail = [
    item.title,
    ghost ? "Completed" : ring && ringLabels[ring],
    stale,
    stamp,
    rollup && `Descendants: ${ringLabels[rollup]}`,
    total > 0 && `${done} of ${total} complete`,
  ]
    .filter(Boolean)
    .join(" · ");
  return { detail, stamp, badge };
}

function BubbleCallout({
  label,
  point,
  radius,
  scale,
}: {
  label: OutsideLabel;
  point: Point;
  radius: number;
  scale: number;
}) {
  const { x, y, lines, stamp, halfWidth, halfHeight } = label;
  const dx = x - point.x;
  const dy = y - point.y;
  const edge = Math.min(halfWidth / Math.abs(dx), halfHeight / Math.abs(dy));
  const length = Math.hypot(dx, dy);
  const start = radius / length;
  const font = RADAR_LABEL_FONT / scale;
  return (
    <g className="radar-callout" aria-hidden="true">
      <line
        x1={dx * start}
        y1={dy * start}
        x2={dx * (1 - edge)}
        y2={dy * (1 - edge)}
      />
      <g transform={`translate(${dx},${dy})`}>
        <text textAnchor="middle" fontSize={font}>
          {lines.map((line, index) => (
            <tspan
              key={index}
              className="radar-bubble-title"
              x={0}
              y={-halfHeight + 3 / scale + (index + 0.5) * font}
              dy="0.35em"
            >
              {line}
            </tspan>
          ))}
          {stamp && (
            <tspan
              className="radar-callout-time"
              x={0}
              y={halfHeight - 3 / scale - font / 2}
              dy="0.35em"
            >
              {stamp}
            </tspan>
          )}
        </text>
      </g>
    </g>
  );
}

/** Circles stay circle elements; other shapes are outlines of equal area. */
function Outline({
  shape,
  r,
  ...rest
}: { shape: ItemShape; r: number } & Omit<
  SVGProps<SVGCircleElement>,
  "r" | "ref"
>) {
  return shape === "circle" ? (
    <circle r={r} {...rest} />
  ) : (
    <path d={shapePath(shape, r)} {...(rest as SVGProps<SVGPathElement>)} />
  );
}

export const RadarBubble = memo(function RadarBubble({
  bubble,
  selected,
  live,
  now,
  labelScale,
  project,
  shape = "circle",
  outsideLabel,
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
  labelScale: number;
  /** The item's project, unless it is in Inbox. */
  project?: { color: ProjectColor; code: string };
  shape?: ItemShape;
  outsideLabel?: OutsideLabel;
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
  const { item, point, radius, ring, rollup, opensGoal } = bubble;
  const ghost = item.status === "done";
  const showResize = selected && live && !ghost;
  const { detail, stamp, badge } = bubbleDetails(bubble, now, timeFormatter);
  const { done, total } = item.progress;
  const { font, lines, visibleBadge, badgeY, labelY } = bubbleLabel(
    item.title,
    stamp,
    badge,
    radius,
    labelScale,
  );
  const progressRadius = radius + (ring ? 5 : 2);
  const handle = (radius + 6) / Math.SQRT2;
  const badgeFont = (RADAR_LABEL_FONT - 2.5) / labelScale;
  const badgeHeight = 14 / labelScale;
  const badgeWidth = project
    ? project.code.length * badgeFont * 0.68 + 10 / labelScale
    : 0;
  const badgeTop = shapeTop(shape, radius) + (ring ? 3 : 0);

  return (
    <g
      className="radar-node"
      transform={`translate(${point.x},${point.y})`}
      style={{ transform: `translate(${point.x}px,${point.y}px)` }}
    >
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
        {ring === "live" && (
          <Outline shape={shape} className="radar-pulse" r={radius + 3} />
        )}
        {rollup && (
          <Outline
            shape={shape}
            className="radar-state radar-rollup"
            data-ring={rollup}
            r={radius + (ring ? 9 : 6)}
          />
        )}
        {ring && (
          <Outline
            shape={shape}
            className="radar-state"
            data-ring={ring}
            r={radius + 3}
          />
        )}
        <Outline
          shape={shape}
          r={radius}
          className="radar-disc"
          data-project={project?.color}
        />
        {selected && (
          <Outline
            shape={shape}
            r={radius + (rollup ? 13 : 8)}
            className="radar-selection"
          />
        )}
        {total > 0 && (
          <>
            <Outline
              shape={shape}
              r={progressRadius}
              className="radar-progress-track"
            />
            {done > 0 && (
              <Outline
                shape={shape}
                r={progressRadius}
                className="radar-progress"
                pathLength={1}
                strokeDasharray={`${done / total} 1`}
                // A circle starts at three o'clock; turn it to twelve.
                transform={shape === "circle" ? "rotate(-90)" : undefined}
              />
            )}
          </>
        )}
        {project && (
          <g
            className="radar-project-badge"
            data-project={project.color}
            aria-hidden="true"
            transform={`translate(0,${-badgeTop})`}
          >
            <rect
              x={-badgeWidth / 2}
              y={-badgeHeight / 2}
              width={badgeWidth}
              height={badgeHeight}
              rx={badgeHeight / 2}
            />
            <text textAnchor="middle" dy="0.35em" fontSize={badgeFont}>
              {project.code}
            </text>
          </g>
        )}
        {!outsideLabel?.lines.length && lines.length > 0 && (
          <text
            textAnchor="middle"
            className="radar-bubble-title"
            fontSize={font}
            aria-hidden="true"
          >
            {lines.map((line, index) => (
              <tspan
                key={index}
                x={0}
                y={labelY + (index - (lines.length - 1) / 2) * font}
                dy="0.35em"
              >
                {line}
              </tspan>
            ))}
          </text>
        )}
        {!outsideLabel?.stamp && visibleBadge && (
          <g
            className="radar-time-badge"
            aria-hidden="true"
            transform={`translate(0,${badgeY})`}
          >
            <rect
              x={-visibleBadge.width / 2}
              y={-visibleBadge.height / 2}
              width={visibleBadge.width}
              height={visibleBadge.height}
              rx={4 / labelScale}
            />
            <text textAnchor="middle" dy="0.35em" fontSize={font}>
              {visibleBadge.text}
            </text>
          </g>
        )}
        {outsideLabel && (
          <BubbleCallout
            label={outsideLabel}
            point={point}
            radius={radius}
            scale={labelScale}
          />
        )}
        {opensGoal && !visibleBadge && radius * labelScale >= 25 && (
          <text
            className="radar-child-count"
            textAnchor="middle"
            y={radius * 0.75}
            fontSize={font}
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
