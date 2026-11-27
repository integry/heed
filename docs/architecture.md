# HEED (`heed.work`) — Product & Technical Specification

**Version:** 2.1 (MVP Blueprint, revised after architecture review)

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
* **Done work leaves the view, not the record.** Completed items leave the canvas by default; turning on "Show completed ghosts" (remembered per browser) keeps them as unobtrusive "ghost moons" for 24 hours. They stay in the Horizon Stream's Completed section and in history forever, so anything can be reopened ("boomeranged") when a follow-up or regression appears.
* **Voice and chat use the same tools.** The in-UI command bar calls the same operations as external agents.

Terminology: an **item** is anything shown in Heed (goal, task, sub-task, meeting). Items render as bubbles (or rectangles, or graph nodes, depending on the lens) in the left pane and as rows in the Horizon Stream. A **project** is a user-defined grouping (e.g. Dev, Marketing, Support, Clients, or one per product). Nesting is capped at four levels: project → goal → task → sub-task.

---

## 2. UI & Interaction Design (ASCII Wireframes)

### 2.0 Direction: the attention field

Heed is agent-first. Agents and the user's own words change things; the screen is for seeing. It must not look or behave like an admin dashboard. The approved visual reference is [design/attention-field.html](design/attention-field.html); where the wireframes and rules in 2.1 to 2.3 disagree with this section, this section wins.

* **The radar is the screen.** It fills the page with no surrounding panels and is the first thing shown after sign-in, including for an empty workspace: the empty rings, the day sentence ("Nothing needs you. Nothing is scheduled.") and the text line. There is no onboarding screen, setup wizard or welcome dialog, and the app does not seed sample items or show first-run hints.
* **One sentence states the day**, over the field: what needs the user, how many agents are working, what is left today. It is derived in the browser.
* **Handoffs are questions.** An item with a handoff shows as a question bubble on the field: who asks, the handoff note, up to four suggested replies as one-tap chips when the agent supplied them, and "Type a reply". Answering stores the reply for the agent (section 6, "Answers to handoffs"), clears the handoff and removes the bubble.
* **One text line drives everything.** It is always visible at the bottom and focused on load on desktop. Text typed there is interpreted against the selected item if there is one ("done", "Friday", "make it urgent"), otherwise against the workspace ("move the SDK upgrade to Friday", "what is blocked?", "zoom into today", "from now on only notify me about billing"). A one-line reply appears above it. Voice uses the same line.
* **solv.chat interprets free text.** Arbitrary input on the line is handled by a [solv.chat](https://github.com/integry/solv.chat) assistant. It reads and changes the workspace through Heed's own `/mcp` endpoint using the same tools as other agents. The app passes a 15-minute, workspace-bound `steer` access token to the widget as the visitor's credential. Writes are attributed to the signed-in user and lock fields like other human edits. The app registers four view-only page actions: select an item, zoom a band, switch lens, and open the guidance editor. The line calls the widget's `send(text)` method and shows the reply. “Open chat” opens the widget's side panel and focuses it. Widgets without `send` open the panel for free text, and widgets without visitor credential support are unavailable. The assistant can run on a self-hosted solv.chat engine with the host's model credentials or on a hosted engine. Configure the widget with the `mountApp` option or with `SOLV_WIDGET_URL` and `SOLV_ASSISTANT_KEY` in the open build.
* **The line still works with nothing configured.** A small deterministic interpreter in the browser handles the common commands without a model: zoom and lens changes, show or hide, done, reopen, cancel, relative and weekday dates, priority words, replying to a question, adding an item ("add …"). It runs first, so these are instant. With no solv.chat assistant configured, other text goes to the built-in command model when one is configured (section 7), and otherwise the reply lists what the line understands.
* **No forms.** There is no inspector form, no dropdown anywhere, and no settings screens made of fields. Selecting an item shows a short summary by the line (title, who, latest note, criteria with verdicts, link) and the item's recent activity in the side list. Changes are said, dragged, or left to defaults. The few things that must be entered (guidance text, a new token's label) are a single text field reached by saying so ("edit guidance", "new token for claude code").
* **Sensible defaults.** Nothing asks the user to choose before they can act: timezone comes from the browser, new items go to Inbox and today, tokens default to `report` scope, lens defaults to radar.
* **The stream is a plain list** in a quiet column beside the field (below it on a phone): Needs you, Working now, Today, Done, This week. Typographic rows, not cards. Other lenses (board, treemap, list) remain, reached by saying their name or by keyboard, not by a control that is always on screen.
* **Visual language.** Follow the reference: a dark field by default with a light theme that follows the system, warm paper-white type, one signal colour reserved for "needs you", one for live agent work, a display face for the sentence, a monospace face for times and agent names. No card grids, pill-button toolbars or boxed panels.

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
* **Time zoom (radar lens).** Clicking a ring's label, or zooming into a ring, splits that band; clicking a bubble still opens its children. Only one band is split at a time, and "Fit" returns to the whole radar.
  * **This week** splits into one sub-ring per remaining day. Dropping a bubble on a day schedules it for that day.
  * **Later** splits into weeks for the next four weeks, then months.
  * **Today** does not split into hours, because only fixed-time and deadline items have a time and agents are not scheduled. It splits by attention instead, from the centre outwards: Needs me, Live now, Next (in the user's manual order), Done today. Fixed-time and deadline items due today are also marked on the rim at their hour, clock-style, so the day's hard points are visible.
  * **Backlog** has no time and splits by project.
  * The split is derived in the browser from the same fields as the bands (section 5); nothing new is stored.
* **Nesting by drag (radar lens).** Dropping a bubble onto the middle of another bubble makes it a child of that item; a glancing overlap still moves the item in time. Inside an item, dropping a bubble outside the item's circle moves it one level up, and dropping it on a breadcrumb moves it under that level ("All projects" is the top level). The drop target is outlined while dragging, and a drop that would create a cycle or a fourth level is refused with a short message.
* **Finish by drag or tap (radar lens).** While a bubble is being moved, two large targets appear across the bottom of the radar: **✓ Done** and **⊘ Won't do** (never "Cancel", which reads like cancelling the drag). They also appear, a little smaller, as buttons while an open item is selected (named "Mark … done" and "Mark … won't do"). These resting buttons sit in their own row under the radar, never over bubbles or sector labels: a wide screen always reserves the row, and a single column adds it below the radar while the item is selected, so the radar never resizes; during a drag the row keeps its place and the large targets overlay the radar. Tapping one finishes the selected item exactly like a drop, and they go once the item is finished. Over a target the bubble previews its finished look, and dropping there marks the item done or cancelled; a finish target wins over every other drop. A one-line message confirms it ("Marked … done.") with an **Undo** button, and says how many sub-items are still open; finishing a parent finishes only that item. Undo sends the socket mutation `UNDO_FINISH`, which restores the previous status without counting as a reopen (the reopen count, reason and schedule stay as they were). It is allowed only for the person whose finish was the item's latest status change, within 10 minutes, and is not an MCP tool. Inside an item the time chips sit above the finish targets. Open question cards are hidden for the length of the drag so they never cover a target, and come back unchanged when it ends. While the targets merely rest under a selection, or a drop message shows, the question cards and the inspector sit above them and the message instead of hiding.
* **Click to start (radar lens).** Clicking empty space inside the rings puts a prefix for that spot in the text line and focuses it, so the person only types the title: the sector's project and the ring in lower case (`dig.vin backlog: `), a split ring's day or week instead of the band (`dig.vin Thursday: `), or inside an item `<item> › <band>: `, which also sends the item as the request's selected item so the new work becomes its child. The command model reads "<project> <band>: <title>" as an addition there. With an item selected the first click only deselects. Until the person edits it the prefix is temporary: another empty click replaces it, and any other click, Escape or switching lens removes it; once edited it is never touched. Nothing is prefilled while the line is busy (sending, a clarification, voice) or the workspace is not live. A faint dashed placeholder bubble in the project's colour, at the default priority's size, marks the clicked spot (moved inside the cell, or inside the item's circle, so it fits); it is decorative, never moves other bubbles, fades in unless reduced motion is set, and follows the prefix: it moves with a new empty click, goes when an untouched prefix is removed, stays while the person types a title after the prefix, and goes on submit, when the line is emptied, or when the prefix is edited so it no longer matches.
* **Project identity (radar lens).** Every project other than Inbox has a colour from a palette of six (violet, sky, rose, lime, indigo, clay; amber and teal stay reserved for status) and a badge code of one to four characters, two letters from the name by default. A new project takes the least-used colour. Bubbles are tinted with their project's colour and carry the badge on their top edge. Item tags can map to a shape (square, diamond, hexagon; circle by default), stored as `tag_shapes` in workspace settings; shapes keep the circle's area so size still reads as priority. All of this is set by typing ("make Goforex violet", "call Goforex GFX", "show calls as squares") or by MCP (`update_project`, `set_tag_shape`). See [the mock-up](design/project-identity.html).
* **Read first.** Heed is mostly looked at, so every surface shows information before controls. The inspector opens as a read-only card: title, status, who is on it, latest note, link, acceptance criteria with their shadow verdicts, child progress and the timeline. Editing happens by direct manipulation (drag to schedule, reorder and move; resize for priority), by clicking a title or criterion to edit it in place, or through the command bar. Fields that still need a form (time type and time, tags, dependencies, project, unlocking) sit behind one "Edit details" disclosure that is closed by default. The four primary actions stay visible: mark done or reopen, flag or clear handoff, hide, delete. No dropdown is used where a small set of tabs or chips fits; the lens switcher is a row of tabs.
* **Cross-highlighting.** Selecting a bubble highlights its row in the Horizon Stream, and vice versa.
* **Progress arcs.** A parent bubble shows `done children / all non-cancelled children`. The count includes children that have left the ghost layer, so progress never goes backwards.
* **Carried over.** Unfinished items scheduled for an earlier day stay in Today and show the day they came from ("from Thu").
* **Stable layout.** Bubbles the user has dragged stay where they were put. The rest are placed deterministically within their ring and sector (seeded per item, simulation only re-run for added/removed nodes) so the field does not jitter when agents report.
* **Stream order.** Within a band: fixed-time items in time order, then manually ordered items, then the rest by priority.
* **Agents panel.** The header's agent count ("3 agents connected · 1 working", or "Connect an agent" when none are connected) opens the Agents panel. It lists API tokens and signed-in apps together as **Connected · N**: working agents first (an open active item carries the row's label as `agent_name`), then by most recent use, never-used last. Each row shows its scope, what it is working on or when it was last seen, and whether it is a token or a signed-in app, with an inline-confirmed **Disconnect**. The list is fetched when the panel opens and again when `agents_connected` changes; the assistant's grant is neither listed nor counted. Below it, **Connect an agent** has tabs for Claude Code, Cursor, Codex and Other, each a short numbered list with a copyable snippet filled with this workspace's `/mcp` address; the chosen tab is remembered per device. **Or ask** shows the text-line phrasing for a token ("create a token for my CI bot") for clients that can't sign in. A host that hides the tokens screen gets only the connection instructions. Text in the panel wraps rather than overflowing at any width.
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

* A bubble's ring is its band from section 5, so a carried-over or active item sits in Today. When ghosts are shown, they stay in the ring where they were completed, faded.
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
| solv.chat assistant | Signed-in, same-origin `POST /api/assistant-token` issues a workspace- and audience-bound 15-minute MCP access token labelled `assistant` with `steer` scope | `/mcp` |

* **Self-hosted:** the deployer supplies their own Google OAuth client ID/secret and an `ALLOWED_EMAILS` list. Anyone else is rejected.
* **Hosted:** any Google account can sign in; a registry (D1) maps accounts to workspaces.
* **API tokens** are created from the text line ("new token for claude code", "create a token for my CI bot") and revoked in the Agents panel or by saying so, stored hashed in the workspace DO, and carry a label and a scope:
  * `report` (default, for autonomous agents): add items, report progress, set dependencies, raise handoffs, reopen items, and set priority and schedule following the user's guidance — but never on a field the human has set by hand. May create a project. Cannot rename, hide, reorder or delete projects, change visibility or guidance, change the timezone, clear a handoff or delete an item.
  * `steer` (for the user's own interactive sessions and the in-UI command bar): everything. Changes made with a `steer` token count as made by the human.
* A token's label is the default `agent_name` for everything it reports, so one token per agent or machine gives stable names. A token can also carry a default project for new items.
* The token's workspace ID lets the Worker route to the right DO without a lookup; the DO verifies the secret.
* `/ws` and every mutating `/api/*` request check the `Origin` header; the session cookie is `SameSite=Lax`.
* **MCP sign-in** uses the active browser workspace and requires consent, including the agent label and scope. Codes expire after five minutes and require S256 PKCE. Access tokens last up to one hour. Clients that register for refresh tokens receive rotating credentials with a 90-day grant lifetime. Disconnecting an app in the Agents panel removes the grant and its credentials.
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
  hidden INTEGER NOT NULL DEFAULT 0,        -- view toggle
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1))
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
  handoff_options TEXT NOT NULL DEFAULT '[]', -- JSON array of up to 4 suggested replies from the agent
  handoff_answer TEXT,                      -- the human's reply, returned to the agent
  handoff_answered_at TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0,  -- boomerang counter
  reopen_reason TEXT,
  agent_name TEXT,                          -- who is working on it; NULL = the human
  created_by TEXT NOT NULL DEFAULT 'human', -- 'human' | 'agent'
  ref_url TEXT,
  note TEXT,                                -- latest one-line status
  acceptance TEXT NOT NULL DEFAULT '[]',    -- JSON array of "done when" criteria: at most 8, each at most 200 characters
  hidden INTEGER NOT NULL DEFAULT 0,        -- view toggle; steer-only
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
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
  kind TEXT NOT NULL,                       -- 'created' | 'status' | 'note' | 'handoff' | 'reopened' | 'moved' | 'notified' | 'judged' | 'judge_feedback' | 'answered'
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

Legacy demo flags stay in the schema for migration. The migration removes sample rows, reattaches real descendants to the nearest surviving ancestor, and moves real items in removed projects to Inbox.

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
* A new item with no parent and no project goes to the token's default project, or to Inbox. A project is named by its ID or its name; any caller may create one, and creating a name that exists returns the existing project.
* When the human (UI, voice, or a `steer` token) sets `priority`, `scheduled_on`, `sort_key`, `acceptance` or position, that field is added to `locked_fields`. A `report` token's write to a locked field is ignored and the response says so. The human can unlock a field from the inspector.
* Parents never complete automatically; when the last open child finishes, the parent shows a full progress arc and waits.
* Every status change, note, handoff, reopen, move and push is appended to `events`.
* When an item first becomes `active` with no `scheduled_on`, `scheduled_on` is set to today.
* `set_dependency` rejects edges that would create a cycle.
* Reopening sets `status = 'queued'`, clears `completed_at`, increments `reopen_count` and sets `scheduled_on` to today.
* `report` agents cancel. Hard deletion is for the human and `steer` callers (the text line and the assistant included), and removes the item's children with it.

Out of scope for the MVP: calendar sync (fixed-time items such as meetings are entered by hand or by voice; a read-only calendar feed import is a later candidate) and recurring items.

---

## 6. MCP Tool Contract

Served at `/mcp` (Streamable HTTP). The same operations back `/api/command` and the UI. Updates are partial: an omitted field is left unchanged.

| Tool | Parameters | Behaviour |
| --- | --- | --- |
| `get_canvas` | `project?`, `parent_id?`, `query?`, `include_done?`, `limit?` | Returns the user's current guidance plus a compact list of items (ID, title, project, status, parent, link) so an agent can find the item to report against and avoid creating duplicates. It is not a work queue. |
| `add_item` | `title`, `project?`, `parent_id?`, `external_key?`, `tags?`, `priority?`, `scheduled_on?`, `time_type?`, `time_at?`, `ref_url?`, `note?`, `status?`, `agent_name?`, `acceptance?` | Creates an item or sub-item, placed according to the guidance. With an `external_key` that already exists, updates that item instead of creating a duplicate. |
| `report_progress` | `item_id` or `external_key`, `status?`, `note?`, `ref_url?`, `agent_name?`, `evidence?` | Heartbeat plus optional status change (`active`, `blocked`, `done`, `cancelled`). Without `status` it only refreshes the heartbeat and note. `evidence` (at most 4,000 characters) is accepted with `status: "done"` and stored on that status event. |
| `update_item` | `item_id`, `title?`, `tags?`, `ref_url?`, `parent_id?`, `priority?`, `scheduled_on?`, `time_type?`, `time_at?`, `acceptance?`; steer-only: `project?`, `hidden?`, `sort_key?`, position, unlock | Edits an item. Writes to human-locked fields from a `report` token are ignored and reported back. |
| `set_dependency` | `item_id`, `blocked_by_id`, `action: "add"｜"remove"` | Adds or removes a dependency edge. |
| `flag_handoff` | `item_id`, `note`, `options?`, `notify?` | Marks the item as needing a human decision or input and records exactly what is needed. With `notify: true` it also sends a push notification. Clearing the flag is steer-only. |
| `answer_handoff` | `item_id`, `text` | Human or steer only. Records a reply to an open handoff and clears the flag. |
| `reopen_item` | `item_id` or `external_key`, `reason` | Brings a done item back (boomerang), at any age. |
| `set_guidance` | `text` | Steer-only. Replaces the guidance text (used by the command bar: "from now on…"). |
| `list_projects` | none | Lists projects with ID, name, colour and visibility, in display order. |
| `create_project` | `name`, `color?` | Creates a project, or returns the existing one with that name. Counts against the hosted project limit. |
| `update_project` | `project`, `name?`, `color?`, `code?`, `hidden?` | Steer-only. Renames, recolours, hides or shows a project. |
| `move_project` | `project`, `direction: "up"｜"down"` | Steer-only. Moves a project one place in the display order. |
| `delete_project` | `project` | Steer-only. Deletes an empty project. |
| `delete_item` | `item_id` | Steer-only. Permanently deletes an item and its children. |
| `clear_handoff` | `item_id` | Steer-only. Withdraws an open question without answering it. |
| `set_timezone` | `timezone` | Steer-only. Sets the workspace timezone (IANA name). |
| `set_tag_shape` | `tag`, `shape` | Steer-only. Draws items with that tag as a circle, square, diamond or hexagon. |
| `get_item` | `item_id` | Returns one item in full with its 20 most recent events; long text is shortened. |

**Everything about the work is reachable by tool.** MCP and the text line expose one shared list, and a `steer` caller can do through it whatever the human can do to items, projects, dependencies, handoffs, guidance and the timezone. `project` parameters take a name or an ID. `tools/list` omits steer-only tools for a `report` token. Credentials and the workspace itself stay with the signed-in human: API tokens, connected apps, push subscriptions, export and reset are not tools.

Every tool response includes `guidance_updated_at`, so a long-running agent can tell the guidance has changed and re-read it with `get_canvas`.

`POST /api/report` accepts the same body as `report_progress` over plain HTTP, so session hooks (start, stop) can report without relying on the model to call a tool.

### Acceptance criteria and the shadow judge

An item may carry up to eight short acceptance criteria ("done when…"), set by the human or by the agent that creates the item. A `done` report may carry `evidence`: the output that shows the criteria are met, such as a test summary, a CI result or a link. Both are useful to the human on their own and are always available.

The judge is optional and off unless a host configures it (section 8). It is a decision model (the reference target is TypeSafe's Jev): given a state and typed questions it returns probabilities, not text. When a report sets an item to `done`, the item has at least one criterion, and a judge is configured:

1. The Durable Object stores the report as usual and returns the judging input to the Worker. The report response is not delayed.
2. The Worker, inside `ctx.waitUntil`, sends one request with one yes/no question per criterion ("Does the evidence show this criterion is met?"). The state holds the item title, the criteria, the evidence, the report note and the user's guidance as separate labelled fields, and the instructions say that the note and evidence are claims by the party being judged.
3. The Worker makes one further Durable Object call that appends a `judged` event: the model ID that answered, a probability per criterion, and whether evidence was supplied. This is one row written per judged report.

The judge runs in **shadow mode** only:

* A verdict never changes `status`, `handoff`, Needs me, the roll-up ring or any other derived state, and never sends a push.
* Verdicts are never returned to agents: not in tool responses, `get_canvas` or `/api/report`. An agent must not be able to tune its report against the judge.
* The human sees the verdict in the inspector, next to the criteria it judged and labelled as a shadow verdict, with each criterion shown as likely met (probability at or above 0.7), likely not met (at or below 0.3) or unclear. Two buttons record whether the human agrees; that writes a `judge_feedback` event. A judged item also carries a small marker in the stream, shown only to signed-in humans.
* Settings shows the agreement between verdicts and feedback over the retained events, so thresholds can be chosen from the workspace's own data before any verdict is allowed to act.

A failed, refused or rate-limited judge call is dropped silently and recorded nowhere; judging is never retried and never blocks a report. The model ID is pinned by configuration, since a moved alias would invalidate any threshold derived from past verdicts.

Why shadow only: published evaluations find Jev well calibrated and close to frontier judges when a verdict can be read from the evidence, weaker when it must be derived (code, maths, logic), and markedly more easily swayed than generative judges by text addressed to the evaluator. In Heed the agent being judged writes the report, so a verdict cannot be trusted to mark work verified until a workspace's own agreement data says so. Acting on verdicts (a "disputed" state that feeds Needs me, and a `review_item` tool for reviewer agents) is deliberately left for a later revision.

### Answers to handoffs

A handoff is a question, and the answer has to reach the agent that asked.

* `flag_handoff` accepts `options?`: up to four suggested replies of at most 60 characters each, shown as one-tap chips.
* The human answers from the field, the text line or voice (a human or `steer` operation, `answer_handoff(item_id, text)`, at most 2,000 characters). It stores `handoff_answer` and `handoff_answered_at` on the item, clears `handoff`, sets the item back to `active` if it was `blocked`, and appends an `answered` event. A signed-in client can also send `{ "text": "..." }` to `POST /api/items/:id/handoff`.
* The answer is returned to agents as `handoff_answer` (with the original note) in the response to any `report_progress` or `update_item` on that item, in `POST /api/report`, and on that item in `get_canvas`, until the item is next flagged, marked done, or cancelled. Heed does not push it: MCP stays request and response (section 9), so an agent that is waiting calls `report_progress` on the item, no more than once a minute.

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

> Tell the user what you are working on. Call this (1) when you start work, with status "active"; (2) after each meaningful step, or at least every 10 minutes during long work, with a one-line note; (3) when you finish, with status "done", the PR or issue link as ref_url, and as evidence the actual output that shows the item's acceptance criteria are met (test summary, CI result), copied rather than paraphrased; (4) when you cannot continue, with status "blocked" and the reason. If no item exists for the work yet, call add_item first. Always pass a stable agent_name.

**`add_item`**

> Add work to the user's view. Use it when you start something that has no item yet, when you split a task into parts (pass parent_id), or when you discover follow-up work that should not be forgotten (leave it in the backlog). Call get_canvas first to avoid duplicates, and pass external_key (PR URL or repo#branch) so retries update the same item. When the work has a clear finish line, pass acceptance: up to eight short, checkable "done when" statements.

**`flag_handoff`**

> Use when the user must decide or provide something before the work can continue or be trusted: a decision, a review, a credential, a manual step. Say exactly what you need in the note, phrased so it can be answered in one line. When there are obvious answers, pass up to four as options. The user's reply comes back as handoff_answer on your next report_progress for the item; while you wait, report on it no more than once a minute. Set notify to true only if the user's guidance says this kind of thing is worth interrupting them for; a notification reaches their phone immediately. When in doubt, flag without notifying.

---

## 7. Real-Time & Voice Protocol

* **WebSocket (`/ws`)**
  * On connect the DO sends `{ type: "SNAPSHOT", settings, projects, items, dependencies }`. `items` contains every open item plus ghosts, and per-parent done/total counts; older history is not included.
  * On any change it broadcasts `ITEM_UPSERT`, `ITEM_REMOVE`, `PROJECT_UPSERT`, `DEPENDENCY_ADD` or `DEPENDENCY_REMOVE`.
  * UI mutations are sent over the same socket (`ADD_ITEM`, `UPDATE_ITEM`, `SET_STATUS`, `REOPEN_ITEM`, and so on) and run the shared operations. `UNDO_FINISH {item_id}` is socket-only: it reverts a person's own done or cancelled change from the last 10 minutes to the previous status, clearing the completion without touching the reopen count or schedule.
  * Uses the WebSocket Hibernation API so idle tabs do not keep the DO running.
  * History is fetched on demand: `GET /api/history?q=&project=&before=`. An item's timeline comes from `GET /api/items/:id/events`.
* **First-run setup**
  * An empty workspace shows the guide until it is dismissed. Dismissal belongs to the workspace. Settings and empty lens and stream views can reopen the guide.
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
* **`Limits`** — may this workspace do this. `check(workspaceId, action)` answers `{ ok: true }` or `{ ok: false, reason }` for `item.create`, `project.create`, `token.create`, `command`, `transcribe`, `judge`, `push` and `connect` (opening a session or accepting an agent call at all, so a host can suspend a workspace). Refusals are explicit to both the UI and agents. Open build: `basicLimits` — the rate limits and fixed caps configured by vars.
* **`UsageSink`** — `record(workspaceId, event)` receives usage events: command-bar calls with model and token counts, transcription seconds, judge calls with input token counts, pushes sent, agent writes. Called with `ctx.waitUntil`, never awaited on the request path. Open build: `noUsage`.
* **`KeyProvider`** — `commandProvider(workspaceId)` returns the LLM and transcription configuration for the command bar, or nothing when it is unavailable, plus `managed` (the UI then hides bring-your-own-key hints). Open build: `envKeys` — Workers AI or Anthropic from vars and secrets.
* **`JudgeProvider`** — `judge(workspaceId)` returns the shadow judge configuration (`url`, `apiKey`, `model`) or nothing when judging is off. Optional: a host that omits the seam has no judge. Open build: `envJudge` — `JUDGE_URL`, `JUDGE_MODEL` and the `JUDGE_API_KEY` secret; all three must be set, there is no default model. The request and response follow TypeSafe's System One format (`state` plus named typed `questions`), which TypeSafe and OpenRouter both serve.

`createApp(seams, options)` returns `{ fetch }`. `@heedwork/engine` also exports the `Workspace` Durable Object class, which the host must bind and re-export from its own Worker entry. When a host supplies limits for socket mutations or meters push delivery, it binds a subclass and exposes the same seams through the protected `socketLimits` and `pushUsage` getters. Hibernated sockets and background push deliveries run in the Durable Object isolate, outside the Worker request and its seam instances.

Hosts use `Workspace.exportWorkspace()` and `Workspace.resetWorkspace()` for the workspace deletion flow. A host whose auth provider stores workspace OAuth grants outside the Durable Object supplies an idempotent `revokeWorkspaceGrants()` override on its Workspace subclass. The engine calls it during reset through every entry point. The hook must finish before the local wipe and must avoid calling back into the same Durable Object. See [the export format](export-format.md) for the host and browser contracts.

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
| **Shadow judge** | About $0.0001 per judged report at Jev's listed price, plus one DO request and one row written | Off by default. Runs only on a `done` report for an item that has criteria, from the Worker in `waitUntil`, so the Durable Object is not kept awake during the model call. Never retried. |
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
5. **Phase 5 — Acceptance criteria and shadow judge.** Criteria on items, evidence on `done` reports, the optional `JudgeProvider` seam, shadow verdicts and human feedback in the inspector, agreement summary in settings.
6. **Phase 6 — Read-first UI and time zoom.** Read-only inspector card with in-place edits and one "Edit details" disclosure, lens tabs, verdicts shown with their criteria, and the radar time zoom.
7. **Phase 7 — The attention field.** Section 2.0: radar-first screen with no onboarding, the day sentence, handoffs as questions with answers returned to agents, the single text line with its built-in interpreter, removal of forms and dropdowns, the plain list, the new visual language, and the optional solv.chat page actions.
8. **Hosted service.** Built in `heed-cloud` on the published packages: accounts, workspaces and members, plans, billing, landing site.
