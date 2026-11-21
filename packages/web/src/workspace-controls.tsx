import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { TimeTypeSchema } from "@heedwork/core";
import type { Project, TimeType } from "@heedwork/core";
import type { createWorkspaceConnection } from "./workspace-connection";

export type SaveMutation = ReturnType<typeof createWorkspaceConnection>["save"];

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  async function run(action: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The request failed.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { busy, error, run };
}

export async function readApi<T>(
  path: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      body?.error?.message ?? "Couldn’t load the requested data.",
    );
  }
  return response.json();
}

export function Panel({
  title,
  close,
  className,
  children,
}: {
  title: string;
  close: () => void;
  className?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={className}
      onClose={close}
      aria-labelledby="panel-title"
    >
      <div className="panel-heading">
        <h2 id="panel-title">{title}</h2>
        <button type="button" className="subtle" onClick={close}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function ProjectOptions({ projects }: { projects: readonly Project[] }) {
  return projects.map(({ id, name, hidden }) => (
    <option key={id} value={id}>
      {name}
      {hidden ? " (hidden)" : ""}
    </option>
  ));
}

function parseInstant(value: string) {
  return Date.parse(
    value.includes(" ") ? value.replace(" ", "T") + "Z" : value,
  );
}

export function dateLabel(value: string, timezone: string) {
  const instant = parseInstant(value);
  return Number.isFinite(instant)
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }).format(instant)
    : value;
}

function timeFormatter(timezone: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function localTime(instant: number, formatter: Intl.DateTimeFormat) {
  return formatter.format(instant).replace(" ", "T");
}

export function timeInputValue(value: string | null, timezone: string) {
  if (!value) return "";
  const instant = parseInstant(value);
  return Number.isFinite(instant)
    ? localTime(instant, timeFormatter(timezone)).slice(0, 16)
    : "";
}

export function timeInputInstant(value: string, timezone: string) {
  const wallTime = Date.parse(value + "Z");
  if (!Number.isFinite(wallTime)) throw new Error("Enter a date and time.");
  const formatter = timeFormatter(timezone);
  const day = 86_400_000;
  // Check both offsets around a clock change. A repeated time uses its earlier occurrence.
  for (const probe of [wallTime - day, wallTime + day]) {
    const offset = Date.parse(localTime(probe, formatter) + "Z") - probe;
    const instant = wallTime - offset;
    if (localTime(instant, formatter).slice(0, 16) === value)
      return new Date(instant).toISOString();
  }
  throw new Error("That time falls in a clock change. Choose another time.");
}

export const timeLabels: Record<TimeType, string> = {
  flexible: "Flexible",
  fixed: "Fixed time",
  deadline: "Deadline",
};

export function TimeFields({
  type,
  setType,
  at,
  setAt,
  timezone,
}: {
  type: TimeType;
  setType: (type: TimeType) => void;
  at: string;
  setAt: (at: string) => void;
  timezone: string;
}) {
  return (
    <>
      <label className="form-field">
        Time type
        <select
          value={type}
          onChange={(event) =>
            setType(TimeTypeSchema.parse(event.target.value))
          }
        >
          {TimeTypeSchema.options.map((option) => (
            <option key={option} value={option}>
              {timeLabels[option]}
            </option>
          ))}
        </select>
      </label>
      {type !== "flexible" && (
        <label className="form-field time-value">
          {timeLabels[type]} ({timezone})
          <input
            type="datetime-local"
            required
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        </label>
      )}
    </>
  );
}
