import { WorkspaceUserSchema } from "@heedwork/core";
import type { Event, Settings } from "@heedwork/core";

export type EventRow = Omit<Event, "actor"> & {
  actor: string;
  actor_user: string | null;
};

export function readEvent({ actor_user, ...event }: EventRow): Event {
  return {
    ...event,
    actor:
      actor_user === null
        ? event.actor
        : WorkspaceUserSchema.parse(JSON.parse(actor_user)),
  };
}

// The version 1 field lists are explicit so new storage columns stay private.
const sections = [
  { name: "projects", columns: "id, name, color, sort, hidden" },
  {
    name: "items",
    columns: `id, project_id, parent_id, external_key, title, tags, depth,
      priority, scheduled_on, sort_key, layout_pos, locked_fields, time_type,
      time_at, status, handoff, handoff_note, reopen_count, reopen_reason,
      agent_name, created_by, ref_url, note, hidden, last_heartbeat_at,
      completed_at, completed_band, created_at, updated_at`,
  },
  { name: "dependencies", columns: "item_id, blocked_by_id" },
  {
    name: "events",
    columns: "id, item_id, at, actor, kind, detail, actor_user",
  },
] as const;

const CHUNK_ROWS = 128;
const CHUNK_CHARACTERS = 64 * 1024;

export function streamWorkspaceExport(
  sql: SqlStorage,
  { timezone, guidance, guidance_updated_at }: Settings,
  wasReset: () => boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const changes = () => sql.exec("SELECT total_changes() AS count").one().count;
  const initialChanges = changes();
  let section = 0;
  let lastRowId: number | undefined;

  return new ReadableStream({
    start(controller) {
      const settings = JSON.stringify({
        timezone,
        guidance,
        guidance_updated_at,
      });
      controller.enqueue(
        encoder.encode(`{"format_version":1,"settings":${settings}`),
      );
    },
    pull(controller) {
      // SQLite cursors have no snapshot isolation across pulls.
      if (wasReset() || changes() !== initialChanges) {
        controller.error(
          new Error("The workspace changed during export. Try again."),
        );
        return;
      }

      const { name, columns } = sections[section];
      const firstPage = lastRowId === undefined;
      let chunk = firstPage ? `,"${name}":[` : "";
      const rows = sql.exec<{ export_rowid: number }>(
        `SELECT rowid AS export_rowid, ${columns} FROM ${name}
         ${firstPage ? "" : "WHERE rowid > ?"} ORDER BY rowid LIMIT ${CHUNK_ROWS}`,
        ...(firstPage ? [] : [lastRowId]),
      );
      let count = 0;
      for (const { export_rowid, ...row } of rows) {
        const value = name === "events" ? readEvent(row as EventRow) : row;
        chunk += (lastRowId === undefined ? "" : ",") + JSON.stringify(value);
        lastRowId = export_rowid;
        count++;
        if (chunk.length >= CHUNK_CHARACTERS) break;
      }
      if (count < CHUNK_ROWS && chunk.length < CHUNK_CHARACTERS) {
        chunk += "]";
        section++;
        lastRowId = undefined;
      }
      const done = section === sections.length;
      if (done) chunk += "}";
      if (chunk) controller.enqueue(encoder.encode(chunk));
      if (done) controller.close();
    },
  });
}
