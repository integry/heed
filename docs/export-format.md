# Workspace export format

Workspace owners can download `heed-workspace.json` from Settings → Data or with `GET /api/export` using their browser session. The endpoint returns a streamed UTF-8 JSON document as an attachment with `Cache-Control: no-store`. If data changes before the stream finishes, the download can fail. Retry to get a consistent export.

## Version 1

| Key              | Contents                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format_version` | The integer `1`. This versions the export independently of the storage schema.                                                                                                 |
| `settings`       | An object with `timezone` (an IANA time zone, defaulting to `UTC`), `guidance` (a string), and `guidance_updated_at` (a UTC timestamp or `null`).                              |
| `projects`       | Project records with `id`, `name`, `color`, `sort`, and `hidden`, including Inbox and hidden projects.                                                                         |
| `items`          | Item records across all statuses, including completed, cancelled, and hidden items.                                                                                            |
| `dependencies`   | Edges with `item_id` and `blocked_by_id`. The latter identifies the item blocking the former.                                                                                  |
| `events`         | Retained item history. Each event has `id`, `item_id`, `at`, `actor`, `kind`, and `detail`. The actor is either a name string or a user object with `id`, `email`, and `name`. |

Each item has an `id`, `project_id`, optional parent reference `parent_id`, and these fields:

- Identity and content include `external_key`, `title`, `tags`, `acceptance`, `agent_name`, `created_by`, `ref_url`, and `note`.
- Placement and scheduling include `depth`, `priority`, `scheduled_on`, `sort_key`, `layout_pos`, `locked_fields`, `time_type`, `time_at`, and `hidden`.
- Workflow includes `status`, `handoff`, `handoff_note`, `handoff_options`, `handoff_answer`, `handoff_answered_at`, `reopen_count`, `reopen_reason`, `last_heartbeat_at`, `completed_at`, `completed_band`, `created_at`, and `updated_at`.

Arrays can be empty and their order has no semantic meaning. Flags such as `hidden` and `handoff` are integers (`0` or `1`). The `tags`, `acceptance`, `layout_pos`, and `locked_fields` item fields are strings containing JSON. Decode `acceptance` to get an array of up to eight criteria of up to 200 characters each. Items without criteria use `"[]"`. Earlier version 1 exports may omit `acceptance` and the three handoff reply fields.

Decode `handoff_options` as a JSON array of up to four suggested replies of 1 to 60 characters each. An item without suggestions uses `"[]"`. The `handoff_answer` field contains the latest reply, up to 2,000 characters, and `handoff_answered_at` records when it was sent. Both are `null` when there is no current reply.

Event `detail` is a string or `null` and can contain JSON depending on the event kind. The decoded detail of a `status` event contains `old` and `new` statuses. When a report changes the status to `done` and supplies evidence, that detail also contains an `evidence` string of up to 4,000 characters. The decoded detail of an `answered` event has a `text` field with the reply. Timestamps can use ISO 8601 or SQLite's UTC `YYYY-MM-DD HH:MM:SS` representation.

The export excludes API token records and hashes, OAuth grants, push subscriptions, quotas, and other internal state. Workspace content and event actors can contain sensitive information. Import is out of scope.

## Workspace reset

`POST /api/reset` requires an owner session, a same-origin request, and the exact JSON body `{"confirmation":"RESET WORKSPACE"}`. A successful reset returns `{"ok":true}`, closes workspace WebSockets, revokes API tokens and workspace OAuth grants, and recreates the workspace with default settings and Inbox. Existing browser sign-in can still open the empty workspace.

Trusted hosts can call `exportWorkspace()` on the Workspace Durable Object stub and pipe the returned byte stream to an attachment response before deleting a workspace. Call `resetWorkspace()` to wipe the workspace's SQL and key-value storage and reapply migrations. The host controls access to these internal methods, its workspace registry, and any OAuth grants it stores outside the Durable Object. Hosts with external grants implement the idempotent `revokeWorkspaceGrants()` hook on their Workspace subclass to revoke those grants for both owner-driven resets and host deletion. The hook runs inside the reset operation and must complete before storage is wiped.
