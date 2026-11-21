# HEED (`heed.work`) — Product & Technical Specification

**Version:** 1.6 (MVP Blueprint, revised after architecture review)

**Model:** Open source (MIT, self-hostable). The hosted service (`heed.work`) is a separate private layer; see section 8.

**Stack:** Cloudflare Workers · SQLite Durable Objects · WebSockets · React + TypeScript + D3 · MCP

---

## 1. Product Thesis & Core Principles

Traditional task trackers (Jira, Linear, Asana) assume human-speed execution and manual board grooming. **Heed** is a human-first attention view for mixed human-and-agent work. It answers one question: **what do *I* have to work on, and what is the state of everything else?**

* **Human-first.** The primary reader is the person, not the agent. Every view is organised around what needs their attention now, today and next.
* **Display, not dispatch.** Heed shows work status. Agents report into it; they do not pull work from it or use it to direct themselves.
* **Human steers, agents report.** Agents add items, break them down, place them, report progress and raise handoffs over MCP. The human can drag, resize, reorder and hide anything, and whatever the human sets by hand wins over what agents set.
* **Guidance is a prompt, not a settings page.** The user keeps one free-form text ("this week billing comes first; park marketing; only notify me about production issues") and can change it at any time. Agents and the in-app command bar read it and follow it when they place items, set priority and decide whether something deserves a notification.
* **"Needs me" means a human decision or input is required.** It is not a list of the user's own tasks.
* **No external sync.** No GitHub/Linear/calendar state syncing. PRs, issues and docs are plain clickable links (`ref_url`).
* **Done work stays in view.** Completed items remain as unobtrusive "ghost moons" for 24 hours and stay in history forever, so anything can be reopened ("boomeranged") when a follow-up or regression appears.
* **Voice and chat use the same tools.** The in-UI command bar calls the same operations as external agents.

Terminology: an **item** is anything shown in Heed (goal, task, sub-task, meeting). Items render as bubbles (or rectangles, or graph nodes, depending on the lens) in the left pane and as rows in the Horizon Stream. A **project** is a user-defined grouping (e.g. Dev, Marketing, Support, Clients, or one per product). Nesting is capped at four levels: project → goal → task → sub-task.

---

## 2. UI & Interaction Design (ASCII Wireframes)

### 2.1 Desktop Browser Layout (Split-Pane)

```text
+---------------------------------------------------------------------------------------------------+
|  (*) HEED   [x]Dev [x]Marketing [x]Support [ ]Clients     | Lens: [Radar v]    |  ● 3 Agents Live |
+-------------------------------------------------------------+-------------------------------------+
|                                                             |  HORIZON STREAM      [Needs me: 2]  |
|   BUBBLE FIELD (radar lens, schematic drawing)              |-------------------------------------|
|                                                             |  v Completed Earlier Today (3)      |
|        .---. (ghost)                                        |    [x] OAuth2 PKCE Flow      10:15  |
|       ( C1  )                                               |    [x] Morning Metrics       09:30  |
|         `-'      .-----------.                              |-------------------------------------|
|                 /  (( DEV ))  \   <-- Pulsing Agent Ring    |  === NOW (14:00) ================== |
|     .-------.  | Auth Session  |   ---.                     |                                     |
|    / CLIENTS \ |  Middleware   |      |                     |  TODAY                              |
|   |  14:00    ||  [====--] 2/3 |      |  +---------------+  |  +-------------------------------+  |
|   |  Sync [H] | \   Due 17:00 /       +->| INSPECTOR HUD |  |  | [14:00 FIXED] Client Sync [H] |  |
|    \_________/   `-----------'           | Auth Session  |  |  | Clients · Human Lead          |  |
|                         \ (blocks)       | Claude-Code-1 |  |  +-------------------------------+  |
|         .---------.      v               | PR #421 [->]  |  |  +-------------------------------+  |
|        /  SUPPORT  \  .-------.          | [Flag Handoff]|  |  | [DUE 17:00] Auth Middleware   |  |
|       | ! Boomerang ||  MKTG   |         | [Mark Done]   |  |  | Dev · ((●)) Claude-Code-1 2/3 |  |
|       |  Billing    || v2.4    |         +---------------+  |  +-------------------------------+  |
|        \___________/  `-------'                             |  +-------------------------------+  |
|                                                             |  | [FLEX] ! Billing Escalation   |  |
| - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - |  | Support · Reopened · from Thu |  |
|   BACKLOG (outer ring, by project)                          |  +-------------------------------+  |
|                                                             |                                     |
|   [Dev (2)]            [Marketing (2)]      [Support (2)]   |  TOMORROW & THIS WEEK               |
|    (B1)  (B2)           (B3)   (B4)          (B5)  (B6)     |  · [Tom 16:00] Stripe Rollout       |
|                                                             |                                     |
|                                                             |  LATER                              |
|   +-----------------------------------------------------+   |  · [Nov 30] SOC2 Audit Exporter     |
|   | [MIC]  "Pull B1 into Today & flag Billing handoff"  |   |                                     |
|   +-----------------------------------------------------+   |  BACKLOG (by project / tag)         |
|                                                             |  > Dev (2)           [#tech-debt]   |
|                                                             |  > Marketing (2)     [#quick-win]   |
+-------------------------------------------------------------+-------------------------------------+
```

**Interaction rules:**

* **Needs me.** The stream header counts items that need a human decision or input: handoff-flagged items, plus stale agent work (an agent went silent mid-task). Clicking it filters both lenses to those items.
* **Direct manipulation.** Bubbles can be dragged and resized; resizing sets priority. In the radar lens, dragging a bubble to another ring reschedules it and dragging a top-level bubble to another sector moves it to that project; within its ring and sector it stays where it is dropped. Stream rows can be dragged to reorder within a band, or into another band to reschedule. Anything set this way is locked against agent changes (see section 5).
* **Roll-up.** A parent bubble shows the ring of its most urgent descendant (handoff, then stale, then reopened, then blocked, then live), so problems are visible when zoomed out.
* **Visibility toggles.** Each project chip in the header turns a project on or off. Individual top-level items can also be hidden from the inspector. Hidden things disappear from both lenses and are listed under a "Hidden" filter. Visibility is stored in the workspace, so it follows the user across devices.
* **Semantic zoom.** Clicking a parent bubble zooms in to reveal its sub-items and `blocked_by` arrows.
* **Cross-highlighting.** Selecting a bubble highlights its row in the Horizon Stream, and vice versa.
* **Progress arcs.** A parent bubble shows `done children / all non-cancelled children`. The count includes children that have left the ghost layer, so progress never goes backwards.
* **Carried over.** Unfinished items scheduled for an earlier day stay in Today and show the day they came from ("from Thu").
* **Stable layout.** Bubbles the user has dragged stay where they were put. The rest are placed deterministically within their ring and sector (seeded per item, simulation only re-run for added/removed nodes) so the field does not jitter when agents report.
* **Stream order.** Within a band: fixed-time items in time order, then manually ordered items, then the rest by priority.
* **Guidance editor.** The guidance text is one click away from the header on desktop and from the voice dock on mobile, and can also be changed by voice ("from now on, only notify me about billing").

### 2.2 Lenses

The left pane is a switchable **lens** over the same items. The Horizon Stream stays alongside every lens, and selection, filters and visibility toggles carry over when switching. The chosen lens is remembered per device. The wireframe above shows the pane's contents schematically rather than the exact radar geometry.

| Lens | Layout | Use it for |
| --- | --- | --- |
| **Radar** (default) | Bubbles on concentric rings around the user: Today at the centre, then This week, Later, and Backlog as the dim outer ring. Each project is a sector. Size is priority. | What is close to me now, and how much is piling up where |
| **Board** | Grid of project rows by time-band columns (Today, This week, Later, Backlog), items as cards ordered as in the stream | People who prefer a structured, familiar layout; bulk rescheduling |
| **Treemap** | Nested rectangles per project and goal; area is priority, colour and border carry status | Dense overview with readable labels; small screens |
| **Dependencies** | Left-to-right graph of one goal's items and their `blocked_by` edges; offered when zoomed into a goal | Finding the item that holds up the rest |

```text
            Dev        |      Marketing
        .  .  .  .  .  |  .  .  .  .  .        backlog (outer ring, dim)
          .  ( )  .    |    . (  ) .           later
            .  (( A )) | ( B )  .              this week
   ----------- [ TODAY · you ] -----------     today (centre)
            .  ( C! )  | (D)   .
          .   .   .    |    .   .   .
            Support    |      Clients
```

Radar rules:

* A bubble's ring is its band from section 5, so a carried-over or active item sits in Today. Ghosts stay in the ring where they were completed, faded.
* Dropping a bubble on a ring sets `scheduled_on` to the first day of that band (Today: today; This week: tomorrow; Later: the first day after this week; Backlog: cleared).
* Zooming into a goal shows its children packed inside it; the Dependencies lens is one tap away from there.
* Roll-up rings, progress arcs, ghosts and the stale/live states are drawn the same way in every lens.

The Board is the radar unrolled: rings become columns and sectors become rows, so dragging a card to another column reschedules it and to another row moves it to that project, with the same rules as above. While the Board is open on desktop the Horizon Stream collapses to its Needs me and Completed sections, since the Board already shows the bands.

Left out of the MVP: timeline lanes (a horizontal time axis per project). Most items have no time, so it would be mostly empty; it becomes worthwhile if calendar import is added.

### 2.3 Mobile Layout (PWA)

The split-pane collapses into a full-screen touch-zoomable lens (radar by default) with a 3-stop draggable bottom sheet (`Peek` / `50-50 Split` / `Full Timeline`) and a thumb-zone voice dock.

```text
   [STATE A: RADAR + PEEK SHEET]              [STATE B: 50/50 SPLIT + INSPECTOR]
+---------------------------------+        +---------------------------------+
| 9:41                   ● 3 Live |        | 9:41                   ● 3 Live |
| (*) HEED    [All v]   [Lens v]  |        | (*) HEED    [All v]   [Lens v]  |
+---------------------------------+        +---------------------------------+
|                                 |        |     .-------.    .-----------.  |
|      (C1)                       |        |    / CLIENTS \  /  (( DEV ))  \ |
|              .-----------.      |        |   | 14:00 [H] || Auth Session  ||
|   .-------. /  (( DEV ))  \     |        |    \_________/  \_____________/ |
|  / CLIENTS \| Auth Session |    |        +---------------------------------+
| | 14:00 [H] |  [====--]2/3 |    |        |            =======              |
|  \_________/ \___________ /     |        |  TODAY                          |
|                                 |        |  +---------------------------+  |
|      .---------.   .-------.    |        |  | [14:00] Client Sync   [H] |  |
|     /  SUPPORT  \ /  MKTG   \   |        |  +---------------------------+  |
|    | ! Boomerang |   v2.4    |  |        |  +---------------------------+  |
|     \___________/ \_________/   |        |  | [DUE 17:00] Auth Mid  2/3 |  |
|                                 |        |  | ((●)) Claude-Code-1       |  |
|  - - - Backlog ring - - - - -   |        |  | [Handoff] [Done] [PR ->]  |  |
|   (Dev)   (Marketing) (Support) |        |  +---------------------------+  |
+---------------------------------+        |  +---------------------------+  |
|            =======              |        |  | [FLEX] ! Billing Retry    |  |
|  NOW · 14:00 Client Sync   [H]  |        |  +---------------------------+  |
|  NEXT · Auth Middleware    2/3  |        |  TOMORROW                       |
+---------------------------------+        |  · Stripe Usage Rollout         |
|  [ + Goal ]   (( MIC ))  [List] |        +---------------------------------+
+---------------------------------+        |  [ + Goal ]   (( MIC ))  [List] |
                                           +---------------------------------+
```

---

## 3. System Architecture (Cloudflare-Native)

One Cloudflare Worker serves the frontend (Workers Static Assets), handles auth and MCP, and routes to a **SQLite-backed Durable Object, one per workspace**.

```text
+---------------------------+          +-----------------------------------+
|  Browser / Mobile PWA     |          |  Agents (Claude Code, Cursor,     |
|  (React + D3 + WebSpeech) |          |  Codex) and session hooks         |
+-------------+-------------+          +-----------------+-----------------+
              | session cookie                           | Bearer token
              | HTTPS (/, /api/*) & WSS (/ws)            | /mcp, /api/report
              v                                          v
+--------------------------------------------------------------------------+
|                          CLOUDFLARE WORKER                               |
|  · /              -> static assets                                       |
|  · /auth/*        -> browser sign-in and MCP OAuth endpoints            |
|  · /.well-known/* -> MCP OAuth discovery documents                       |
|  · /ws            -> checks session -> upgrades into Workspace DO        |
|  · /api/*         -> checks session -> Workspace DO (RPC)                |
|  · /api/command   -> checks session -> LLM tool loop -> Workspace DO     |
|  · /mcp           -> route + limit token -> Workspace DO (one RPC)       |
|  · /api/report    -> checks token -> Workspace DO (RPC)                  |
+------------------------------------+-------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
|               WORKSPACE DURABLE OBJECT (1 per workspace ID)              |
|  · SQLite: settings · projects · items · dependencies · events · tokens  |
|  · One set of operations shared by MCP, HTTP, voice/chat and the UI      |
|  · Broadcasts changes to connected WebSockets (Hibernation API)          |
+--------------------------------------------------------------------------+
```

Design notes:

* **MCP is stateless Streamable HTTP.** The Worker routes and rate-limits the token before one Workspace RPC. Inside that call, the Workspace verifies the secret and serves the MCP request using its existing operations. The handler keeps no MCP session and offers JSON responses.
* **The DO is keyed by workspace ID, not user ID**, from day one. Self-hosted deployments use a single workspace, `default`. This keeps shared team workspaces possible later without a data migration.
* **No alarm is needed.** The 24-hour ghost window, staleness and the time bands are all computed at query/render time.
* **Schema versioning.** `settings.schema_version` is checked in the DO constructor and migrations run before any request is served.
* **Push notifications use Web Push** (VAPID keys in Worker secrets, subscriptions stored in the DO), so they work for self-hosted and hosted alike without a native wrapper. On iOS this requires the PWA to be installed to the home screen.
* **Limits.** Notes are capped at 280 characters, guidance at 2,000, `get_canvas` returns at most 50 items by default, writes are rate-limited per token, and pushes are capped per token per hour regardless of what the agent asks for.

---

## 4. Authentication & Authorisation

| Caller | Mechanism | Covers |
| --- | --- | --- |
| Human (browser, PWA) | Google sign-in (OAuth code flow in the Worker) → signed, HttpOnly session cookie | `/`, `/ws`, `/api/*`, `/api/command` |
| Agent / hook | Per-workspace API token, `Authorization: Bearer heed_<workspaceId>_<secret>` | `/mcp`, `/api/report` |
| OAuth-capable MCP client | Browser sign-in and consent, then an audience-bound bearer access token | `/mcp` |

* **Self-hosted:** the deployer supplies their own Google OAuth client ID/secret and an `ALLOWED_EMAILS` list. Anyone else is rejected.
* **Hosted:** any Google account can sign in; a registry (D1) maps accounts to workspaces.
* **API tokens** are created and revoked in Settings, stored hashed in the workspace DO, and carry a label and a scope:
  * `report` (default, for autonomous agents): add items, report progress, set dependencies, raise handoffs, reopen items, and set priority and schedule following the user's guidance — but never on a field the human has set by hand. Cannot change visibility, projects, guidance or clear a handoff.
  * `steer` (for the user's own interactive sessions and the in-UI command bar): everything. Changes made with a `steer` token count as made by the human.
* A token's label is the default `agent_name` for everything it reports, so one token per agent or machine gives stable names. A token can also carry a default project for new items.
* The token's workspace ID lets the Worker route to the right DO without a lookup; the DO verifies the secret.
* `/ws` and every mutating `/api/*` request check the `Origin` header; the session cookie is `SameSite=Lax`.
* **MCP sign-in** uses the active browser workspace and requires consent, including the agent label and scope. Codes expire after five minutes and require S256 PKCE. Access tokens last up to one hour. Clients that register for refresh tokens receive rotating credentials with a 90-day grant lifetime. Revocation in Connected apps removes the grant and its credentials.
* OAuth is implemented directly in `createApp` following the [MCP 2026-07-28 authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). Client registration uses its Dynamic Client Registration compatibility path. Cloudflare’s provider [stores its OAuth state in KV](https://github.com/cloudflare/workers-oauth-provider/blob/main/storage-schema.md). Heed stores registration records in a dedicated, issuer-keyed instance of the Workspace Durable Object class, since registration precedes workspace selection. Consent and credentials live in the selected workspace’s SQLite database. This uses the existing binding and keeps credential rotation and revocation atomic.

---

## 5. Data Model (Durable Object SQLite Schema)

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,                     -- 'schema_version', 'timezone' (IANA, e.g. 'Europe/Tallinn'),
  value TEXT NOT NULL                       -- 'guidance' (free-form text), 'guidance_updated_at'
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0         -- view toggle
);                                          -- a built-in 'Inbox' project always exists

CREATE TABLE items (
  id TEXT PRIMARY KEY,                      -- server-generated short ID
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  external_key TEXT UNIQUE,                 -- optional idempotency key from agents (e.g. PR URL, 'repo#branch')
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',          -- JSON array, e.g. '["tech-debt","quick-win"]'
  depth INTEGER NOT NULL DEFAULT 1 CHECK (depth BETWEEN 1 AND 3), -- 1 goal, 2 task, 3 sub-task
  priority INTEGER NOT NULL DEFAULT 5,      -- 1..10, bubble size (resize handle)
  scheduled_on TEXT,                        -- local date 'YYYY-MM-DD'; NULL = inherit from parent, else backlog
  sort_key REAL,                            -- manual order within a stream band; NULL = not manually ordered
  layout_pos TEXT NOT NULL DEFAULT '{}',    -- manual positions per lens, JSON, e.g. '{"radar":{"angle":0.3,"radius":0.6}}' (fractions within ring/sector)
  locked_fields TEXT NOT NULL DEFAULT '[]', -- JSON array of fields the human set by hand, e.g. '["priority","scheduled_on"]'
  time_type TEXT NOT NULL DEFAULT 'flexible', -- 'flexible' | 'fixed' | 'deadline'
  time_at TEXT,                             -- ISO-8601 instant for fixed/deadline
  status TEXT NOT NULL DEFAULT 'queued',    -- 'queued' | 'active' | 'blocked' | 'done' | 'cancelled'
  handoff INTEGER NOT NULL DEFAULT 0,       -- needs a human decision or input; independent of status
  handoff_note TEXT,                        -- exactly what is needed
  reopen_count INTEGER NOT NULL DEFAULT 0,  -- boomerang counter
  reopen_reason TEXT,
  agent_name TEXT,                          -- who is working on it; NULL = the human
  created_by TEXT NOT NULL DEFAULT 'human', -- 'human' | 'agent'
  ref_url TEXT,
  note TEXT,                                -- latest one-line status
  hidden INTEGER NOT NULL DEFAULT 0,        -- view toggle; steer-only
  last_heartbeat_at TEXT,
  completed_at TEXT,
  completed_band TEXT,                      -- radar ring at completion, retained for ghosts
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE dependencies (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  blocked_by_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, blocked_by_id),
  CHECK (item_id <> blocked_by_id)
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'report',     -- 'report' | 'steer'
  default_project_id TEXT REFERENCES projects(id),
  secret_hash TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (                       -- append-only activity log, feeds the inspector timeline
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,                      -- 'human' or the agent name
  kind TEXT NOT NULL,                       -- 'created' | 'status' | 'note' | 'handoff' | 'reopened' | 'moved' | 'notified'
  detail TEXT                               -- JSON: old/new values, note text, push text
);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys TEXT NOT NULL,                       -- JSON: p256dh, auth
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_item ON events(item_id, at);

-- No secondary indexes on items: a workspace holds hundreds of rows, scans are effectively free,
-- and every index adds to the cost of each write (see section 9).
```

### Derived state (never stored)

All dates are evaluated in the workspace timezone (`settings.timezone`, set from the browser on first sign-in). "Schedule" below means the item's effective schedule: its own `scheduled_on`, or the nearest ancestor's if it has none.

| Derived value | Rule |
| --- | --- |
| **Done today** | `status = 'done'` and `completed_at` is today |
| **Today** | not done/cancelled and any of: schedule is today or earlier; `time_at` is today or overdue; `status = 'active'` |
| **Carried over** | in Today with a schedule before today — unfinished items roll forward automatically and keep their original date for display |
| **Tomorrow / This week / Later** | by schedule, else by the date of `time_at` |
| **Backlog** | no schedule, no `time_at`, not active |
| **Stream rows** | top-level items per band, with their children expandable underneath; a child appears on its own only when its band differs from its parent's |
| **Live** | `status = 'active'` and `last_heartbeat_at` within the last 15 minutes (pulsing ring) |
| **Stale** | `status = 'active'` with an older heartbeat (dim ring, "last seen 2h ago"); status is not changed automatically |
| **Blocked** | `status = 'blocked'` (external reason in `note`) or any `blocked_by` item that is not done |
| **Ghost** | `status = 'done'` and `completed_at` within the last 24 hours |
| **History** | everything done or cancelled, searchable, reopenable at any age |
| **Needs me** | `handoff = 1`, or Stale |
| **Roll-up ring** | a parent shows the most urgent state among its descendants: handoff, stale, reopened, blocked, live |
| **Agents live** | distinct `agent_name` over Live items |

Rules enforced on write:

* A sub-item inherits `project_id` from its parent. Its `depth` is the parent's plus one; a write that would exceed depth 3 is rejected with an error telling the agent to attach to the parent instead.
* A new item with no parent and no project goes to the token's default project, or to Inbox. Agents cannot create projects.
* When the human (UI, voice, or a `steer` token) sets `priority`, `scheduled_on`, `sort_key` or position, that field is added to `locked_fields`. A `report` token's write to a locked field is ignored and the response says so. The human can unlock a field from the inspector.
* Parents never complete automatically; when the last open child finishes, the parent shows a full progress arc and waits.
* Every status change, note, handoff, reopen, move and push is appended to `events`.
* When an item first becomes `active` with no `scheduled_on`, `scheduled_on` is set to today.
* `set_dependency` rejects edges that would create a cycle.
* Reopening sets `status = 'queued'`, clears `completed_at`, increments `reopen_count` and sets `scheduled_on` to today.
* Agents cancel; only the human hard-deletes (UI only).

Out of scope for the MVP: calendar sync (fixed-time items such as meetings are entered by hand or by voice; a read-only calendar feed import is a later candidate) and recurring items.

---

## 6. MCP Tool Contract

Served at `/mcp` (Streamable HTTP). The same operations back `/api/command` and the UI. Updates are partial: an omitted field is left unchanged.

| Tool | Parameters | Behaviour |
| --- | --- | --- |
| `get_canvas` | `project?`, `parent_id?`, `query?`, `include_done?`, `limit?` | Returns the user's current guidance plus a compact list of items (ID, title, project, status, parent, link) so an agent can find the item to report against and avoid creating duplicates. It is not a work queue. |
| `add_item` | `title`, `project?`, `parent_id?`, `external_key?`, `tags?`, `priority?`, `scheduled_on?`, `time_type?`, `time_at?`, `ref_url?`, `note?`, `status?`, `agent_name?` | Creates an item or sub-item, placed according to the guidance. With an `external_key` that already exists, updates that item instead of creating a duplicate. |
| `report_progress` | `item_id` or `external_key`, `status?`, `note?`, `ref_url?`, `agent_name?` | Heartbeat plus optional status change (`active`, `blocked`, `done`, `cancelled`). Without `status` it only refreshes the heartbeat and note. |
| `update_item` | `item_id`, `title?`, `tags?`, `ref_url?`, `parent_id?`, `priority?`, `scheduled_on?`, `time_type?`, `time_at?`; steer-only: `project?`, `hidden?`, `sort_key?`, position, unlock | Edits an item. Writes to human-locked fields from a `report` token are ignored and reported back. |
| `set_dependency` | `item_id`, `blocked_by_id`, `action: "add"｜"remove"` | Adds or removes a dependency edge. |
| `flag_handoff` | `item_id`, `note`, `notify?` | Marks the item as needing a human decision or input and records exactly what is needed. With `notify: true` it also sends a push notification. Clearing the flag is steer-only. |
| `reopen_item` | `item_id` or `external_key`, `reason` | Brings a done item back (boomerang), at any age. |
| `set_guidance` | `text` | Steer-only. Replaces the guidance text (used by the command bar: "from now on…"). |

Every tool response includes `guidance_updated_at`, so a long-running agent can tell the guidance has changed and re-read it with `get_canvas`.

`POST /api/report` accepts the same body as `report_progress` over plain HTTP, so session hooks (start, stop) can report without relying on the model to call a tool.

### User guidance

The guidance is one free-form text the user owns and can rewrite at any time, by typing or by voice. It is the standing rule for how the canvas is formed and when the user is interrupted. Example:

> This week billing comes first — anything touching invoices goes to today at high priority. Park marketing in the backlog unless it has a deadline. Only notify me when production is affected or when you are completely stuck; everything else can wait until I look.

How it reaches agents:

* It is included in the MCP server `instructions` at connect, and returned by `get_canvas`.
* `guidance_updated_at` on every response lets a running agent notice a change.
* The `/api/command` LLM receives it as part of its system prompt.

What it governs: project, priority and schedule of new and updated items (within the lock rule in section 5), how finely agents break work down, and whether a handoff sets `notify`. What it cannot override: scope restrictions, human-locked fields, the nesting cap and the rate limits. An empty guidance text means defaults: new agent items go to the backlog at priority 5, and `notify` is used only when the agent cannot continue at all.

### Tool descriptions are part of the product

Agents only report if the tool text tells them when to. The server `instructions` and each tool description are written as behavioural guidance and are tested like code. Starting text:

**Server instructions**

> Heed is the user's live view of everything they and their agents are working on. It only stays accurate if you report to it. Whenever you do work for the user: find or create the matching item, mark it active when you start, report after each meaningful step, and mark it done, blocked or flagged for handoff when you stop. Heed does not assign work — never pick up items from it on your own initiative. The user's current guidance follows; it decides where items go, how important they are and when the user may be interrupted. Follow it over your own judgement.
>
> *(current guidance text)*

**`report_progress`**

> Tell the user what you are working on. Call this (1) when you start work, with status "active"; (2) after each meaningful step, or at least every 10 minutes during long work, with a one-line note; (3) when you finish, with status "done" and the PR or issue link as ref_url; (4) when you cannot continue, with status "blocked" and the reason. If no item exists for the work yet, call add_item first. Always pass a stable agent_name.

**`add_item`**

> Add work to the user's view. Use it when you start something that has no item yet, when you split a task into parts (pass parent_id), or when you discover follow-up work that should not be forgotten (leave it in the backlog). Call get_canvas first to avoid duplicates, and pass external_key (PR URL or repo#branch) so retries update the same item.

**`flag_handoff`**

> Use when the user must decide or provide something before the work can continue or be trusted: a decision, a review, a credential, a manual step. Say exactly what you need in the note, phrased so it can be answered in one line. Set notify to true only if the user's guidance says this kind of thing is worth interrupting them for; a notification reaches their phone immediately. When in doubt, flag without notifying.

---

## 7. Real-Time & Voice Protocol

* **WebSocket (`/ws`)**
  * On connect the DO sends `{ type: "SNAPSHOT", settings, projects, items, dependencies }`. `items` contains every open item plus ghosts, and per-parent done/total counts; older history is not included.
  * On any change it broadcasts `ITEM_UPSERT`, `ITEM_REMOVE`, `PROJECT_UPSERT`, `DEPENDENCY_ADD` or `DEPENDENCY_REMOVE`.
  * Uses the WebSocket Hibernation API so idle tabs do not keep the DO running.
  * History is fetched on demand: `GET /api/history?q=&project=&before=`. An item's timeline comes from `GET /api/items/:id/events`.
* **Push**
  * The browser registers a Web Push subscription after sign-in (`POST /api/push/subscribe`).
  * A push is sent only when an agent raises a handoff with `notify: true`. The text is the item title plus the handoff note; tapping it opens the item.
* **Voice & chat (`/api/command`)**
  * Audio is transcribed in the browser (Web Speech API) or, where that is unreliable, recorded and sent to Whisper on Workers AI.
  * The text goes to `/api/command`, where a tool-calling LLM maps it to the operations in section 6 with `steer` scope. Example: "Move the rate limiter into today and hide the Clients project."

---

## 8. Open Core and Cloud

This repository is the complete product for a self-hoster: one person or team, one workspace, their own Google OAuth client, their own model keys. The hosted service at `heed.work` is built in a separate private repository, `heed-cloud`, which consumes this repository as published npm packages and plugs in through the seams below. It never forks or patches this code, and nothing here may assume it exists.

| Lives here (MIT) | Lives in `heed-cloud` (private) |
| --- | --- |
| Workspace engine, MCP endpoint, WebSocket, human API | Public sign-up and accounts |
| Web app with all lenses, voice bar, push | Many workspaces, members, invites and roles |
| Google sign-in for an allowed-emails list, single `default` workspace | Plans, usage metering and billing |
| API tokens and MCP sign-in | Managed model keys |
| Self-hosting docs and deploy button | Landing site, operator tooling, `heed.work` deployment |

### Packages

```text
packages/
  core/     @heedwork/core    Shared types, validation schemas, derived-state functions. No Cloudflare dependencies.
  engine/   @heedwork/engine  The Worker: createApp(seams), the Workspace Durable Object class, the open seam implementations.
  web/      @heedwork/web     The React app: mountApp(root, options) and a prebuilt dist/ for hosts that use it unchanged.
```

npm workspaces. All packages share one version and are published together from a `v<semver>` tag (see `docs/releasing.md`). The self-hostable Worker in this repository is a thin entry that calls `createApp` with the open implementations.

### Extension seams

A host replaces these and nothing else. Every method is async so a host may consult its own storage, but the open implementations must keep to section 9: no lookup on an ordinary request beyond the single Durable Object call.

* **`AuthProvider`** — who is this, and which workspace are they in.
  * `session(request)` resolves a browser request to `{ workspaceId, user: { id, email, name }, role }` or nothing.
  * `handleAuthRoute(request)` owns the host’s sign-in, callback, and sign-out routes under `/auth/*`. The engine reserves its MCP OAuth routes under `/auth/mcp/*`.
  * `signIn(request, returnTo)` optionally starts host sign-in for OAuth consent. The engine defaults to `/auth/login?returnTo=…`. Hosts validate the local return path and resume there after sign-in.
  * `workspaceForToken(token)` returns the workspace ID an agent token belongs to, or nothing, **without** instantiating a Durable Object, so tokens for workspaces that do not exist are rejected in the Worker.
  * Open build: `googleAllowlistAuth` — Google sign-in limited to `ALLOWED_EMAILS`, the single workspace `default`, role `owner`.
* **`Limits`** — may this workspace do this. `check(workspaceId, action)` answers `{ ok: true }` or `{ ok: false, reason }` for `item.create`, `project.create`, `token.create`, `command`, `transcribe`, `push` and `connect` (opening a session or accepting an agent call at all, so a host can suspend a workspace). Refusals are explicit to both the UI and agents. Open build: `basicLimits` — the rate limits and fixed caps configured by vars.
* **`UsageSink`** — `record(workspaceId, event)` receives usage events: command-bar calls with model and token counts, transcription seconds, pushes sent, agent writes. Called with `ctx.waitUntil`, never awaited on the request path. Open build: `noUsage`.
* **`KeyProvider`** — `commandProvider(workspaceId)` returns the LLM and transcription configuration for the command bar, or nothing when it is unavailable, plus `managed` (the UI then hides bring-your-own-key hints). Open build: `envKeys` — Workers AI or Anthropic from vars and secrets.

`createApp(seams, options)` returns `{ fetch }`. `@heedwork/engine` also exports the `Workspace` Durable Object class, which the host must bind and re-export from its own Worker entry. When a host supplies limits for socket mutations or meters push delivery, it binds a subclass and exposes the same seams through the protected `socketLimits` and `pushUsage` getters. Hibernated sockets and background push deliveries run in the Durable Object isolate, outside the Worker request and its seam instances.

The human actor carries the `user` from the session, and events record it, so a shared workspace shows who made each change. Lock semantics do not depend on which human it was.

`mountApp(root, options)` from `@heedwork/web` renders the app. Options let a host supply its own sign-in screen and sign-out action, add settings screens and header slots (workspace switcher, account menu), hide built-in screens, and reuse the same API helpers the built-in screens use.

---

## 9. Operating Cost

Target: a single-user self-hosted workspace runs inside the Cloudflare **Workers Free plan**, and a hosted workspace costs cents per month. Figures below are from the Cloudflare pricing pages as of November 2026; re-check them before launch.

What is billed, and what Heed does about it:

| Cost driver | Price signal | Design rule |
| --- | --- | --- |
| **DO duration** | Billed at 128 MB while the object is running; not billed while idle and able to hibernate | Nothing may keep the DO awake: no timers, no alarms, no polling, WebSockets only through the Hibernation API. All time-based state (bands, live/stale, ghosts) is computed in the browser from timestamps, so the server never ticks. |
| **Long-lived connections** | A non-hibernating connection bills duration for as long as it is open | MCP is request/response only: the optional server-to-client stream of Streamable HTTP is not offered. Browser keepalives use protocol pings or `setWebSocketAutoResponse`, which are not charged. |
| **Rows written** | $1.00 per million beyond the allowance — a thousand times the price of rows read | The most important number to keep down. A report that changes nothing but the heartbeat is persisted at most once per 5 minutes per item and writes no event. No secondary indexes on `items`. Events older than 90 days are pruned lazily, at most once a day, as part of an ordinary write. Drags are written on drop, not while dragging. |
| **Requests** | Worker and DO requests are each metered; static assets are free | The SPA is served straight from static assets without invoking the Worker. Session cookies are verified in the Worker by signature, with no DO or database lookup. Malformed or unknown-workspace tokens are rejected before the DO is touched. UI mutations go over the open WebSocket (20 incoming messages bill as 1 request). |
| **Abuse and runaway agents** | An agent stuck in a loop can burn the daily free allowance | Per-token rate limit enforced in the Worker, before the DO. On the free plan, hitting a daily limit makes writes fail until midnight UTC, so the limit is set well below it. |
| **CPU time** | 10 ms per request on the free plan | API tokens are high-entropy and hashed with SHA-256, not a slow password hash. `get_canvas` is bounded. |
| **LLM and speech** | The only cost that scales with use rather than with idle design | Speech is transcribed in the browser where possible; Whisper is the fallback. The command bar uses a small tool-calling model. Self-hosted brings its own key; hosted has a monthly allowance per plan. |
| **Agent context** | Not our bill, but the user's | Guidance is capped at 2,000 characters, since it is injected into every connected agent's context. Tool responses are compact. |

Rough load for one busy workspace — five agents reporting every five minutes for ten hours a day, plus normal UI use:

* about 600–1,000 requests a day against a free allowance of 100,000;
* about 5,000 rows written a day against a free allowance of 100,000;
* DO running time measured in seconds per day against a free allowance of 13,000 GB-s.

For the hosted service the same workspace comes to roughly 20,000–30,000 requests and 150,000 rows written a month, which is on the order of $0.15 per workspace per month at overage prices, almost all of it rows written. Voice and command-bar LLM calls will cost more than everything else combined and are the thing to meter.

---

## 10. Implementation Roadmap

1. **Phase 1 — Core engine.** Worker + workspace DO, schema and migrations, the shared operations, derived-state queries, lock rule, nesting cap, events log, heartbeat write throttling, guidance storage and delivery, API tokens with scopes, limits, `/mcp`, `/api/report`, WebSocket snapshot/broadcast. Tool descriptions and guidance behaviour tried against Claude Code and one other agent.
2. **Phase 2 — Frontend.** Google sign-in and session cookie; Horizon Stream (Needs me, carried-over, drag to reorder and reschedule, history); lens framework with the radar lens (drag between rings and sectors, resize, ghost moons, backlog ring, progress arcs, roll-up rings, stable layout), then the board, treemap and dependencies lenses; inspector with timeline and field unlock; guidance editor; visibility toggles; responsive bottom sheet; PWA manifest.
3. **Phase 3 — Voice, push and open-source launch.** `/api/command` voice/chat bar, Web Push for agent-flagged handoffs, MCP and hook setup docs for Claude Code / Cursor / Codex, public GitHub release.
4. **Phase 4 — Open core.** Package split and published `@heedwork/*` packages, extension seams (`createApp`, `mountApp`), first-run onboarding, MCP sign-in (OAuth), data export and workspace reset.
5. **Hosted service.** Built in `heed-cloud` on the published packages: accounts, workspaces and members, plans, billing, landing site.
