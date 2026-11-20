import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { PushSubscription } from "@block65/webcrypto-web-push";
import { DurableObject } from "cloudflare:workers";
import { z, type ZodType } from "zod";
import { bandsFor, completionBand, isGhost } from "../shared/derived-state";
import { HistoryQuerySchema } from "../shared/human-api";
import type {
  HistoryItem,
  HistoryPage,
  HistoryQuery,
} from "../shared/human-api";
import {
  ActorSchema,
  AddItemSchema,
  CanvasQuerySchema,
  FlagHandoffSchema,
  ItemIdSchema,
  LockableFieldSchema,
  MAX_CANVAS_ITEMS,
  ReopenItemSchema,
  ReportProgressSchema,
  SetDependencySchema,
  UpdateItemSchema,
} from "../shared/item-operations";
import type {
  Actor,
  AddItemInput,
  DependencyOperationResult,
  FlagHandoffInput,
  ItemIdInput,
  ItemOperationResult,
  LockableField,
  ReopenItemInput,
  ReportProgressInput,
  SetDependencyInput,
  UpdateItemInput,
} from "../shared/item-operations";
import {
  CreateProjectSchema,
  CreateTokenSchema,
  DEFAULT_WORKSPACE_ID,
  GuidanceTextSchema,
  INBOX_PROJECT_ID,
  TimezoneSchema,
  UpdateProjectSchema,
} from "../shared/workspace";
import {
  MoveProjectSchema,
  SocketRequestIdSchema,
  SocketRequestSchema,
} from "../shared/workspace-socket";
import type {
  ChildCounts,
  CreatedToken,
  WorkspaceMessage,
} from "../shared/workspace-socket";
import { workspaceOperationError } from "./api-response";
import type {
  Dependency,
  Event,
  EventKind,
  Guidance,
  Item,
  Project,
  Setting,
  Settings,
  Status,
  Token,
  TokenMetadata,
} from "../shared/workspace";
import {
  equalSecretHashes,
  hashSecret,
  isTokenSecret,
  newTokenSecret,
} from "./token-secrets";
import { migrateWorkspace } from "./workspace-migrations";

type CanvasRow = Pick<
  Item,
  | "id"
  | "title"
  | "status"
  | "parent_id"
  | "ref_url"
  | "agent_name"
  | "scheduled_on"
  | "time_at"
  | "completed_at"
> & { project: string };

export function getWorkspaceStub(env: Env, workspaceId = DEFAULT_WORKSPACE_ID) {
  return env.WORKSPACE.getByName(workspaceId);
}

function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues[0].message);
  return result.data;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_USE_INTERVAL_MS = 60 * 60 * 1000;
const TOKEN_METADATA_COLUMNS =
  "id, label, scope, default_project_id, last_used_at, created_at";
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEPTH_ERROR =
  "Items cannot exceed depth 3. Attach to the parent of the proposed parent instead.";
const STEER_FIELDS = [
  "project",
  "hidden",
  "sort_key",
  "layout_pos",
  "unlock",
] as const;
const MOVE_FIELDS = ["scheduled_on", "project_id", "parent_id"] as const;

type ItemPatch = Partial<Omit<Item, "id" | "created_at" | "updated_at">>;
type ItemEdit = Partial<AddItemInput & UpdateItemInput>;
type WorkspaceEnv = Env & {
  VAPID_SUBJECT?: string;
  VAPID_SERVER_PUBLIC_KEY?: string;
  VAPID_SERVER_PRIVATE_KEY?: string;
};
type ItemChange =
  { before?: Item; after: Item } | { before: Item; after?: undefined };
type Mutation = {
  actor: Actor;
  now: Date;
  timezone: string;
  changes: ItemChange[];
  throttledHeartbeat?: Item;
  removedDependencies?: Dependency[];
  ignored: Set<LockableField>;
  pruneEvents: boolean;
};

function isReport(actor: Actor): boolean {
  return actor.kind === "agent" && actor.scope === "report";
}

function isTerminalStatus(status: Status): boolean {
  return status === "done" || status === "cancelled";
}

function isCanvasItem(item: Item, now: number): boolean {
  return !isTerminalStatus(item.status) || isGhost(item, now);
}

function requireSteering(actor: Actor, action: string): void {
  if (isReport(actor))
    throw new Error(
      `Report scope cannot ${action}. Use a human or steer actor.`,
    );
}

function today({ now, timezone }: Mutation): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function timestamp(value: string): number {
  // Schema defaults use SQLite UTC timestamps; item mutations use ISO instants.
  return Date.parse(
    value.includes(" ") ? value.replace(" ", "T") + "Z" : value,
  );
}

export class Workspace extends DurableObject<WorkspaceEnv> {
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    void ctx.blockConcurrencyWhile(async () => {
      migrateWorkspace(ctx.storage);
    });
  }

  fetch(request: Request): Response {
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    const snapshot = this.#snapshot();
    this.ctx.acceptWebSocket(server);
    this.#send(server, snapshot);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let data: unknown;
    if (typeof message === "string") {
      try {
        data = JSON.parse(message);
      } catch {
        // Invalid JSON is handled by the protocol validator below.
      }
    }
    const request = SocketRequestSchema.safeParse(data);
    if (!request.success) {
      const id = SocketRequestIdSchema.safeParse(
        data && typeof data === "object" && "requestId" in data
          ? data.requestId
          : undefined,
      );
      this.#send(socket, {
        type: "ERROR",
        requestId: id.success ? id.data : null,
        error: {
          code: "invalid_input",
          message: request.error.issues[0].message,
        },
      });
      return;
    }
    if (request.data.type === "GET_SNAPSHOT") {
      this.#send(socket, this.#snapshot());
      return;
    }

    const actor = { kind: "human" } as const;
    const { requestId } = request.data;
    let createdToken: CreatedToken | undefined;
    try {
      const mutation = request.data;
      switch (mutation.type) {
        case "ADD_ITEM":
          this.addItem(actor, mutation.input);
          break;
        case "DELETE_ITEM":
          this.deleteItem(actor, mutation.input);
          break;
        case "REOPEN_ITEM":
          this.reopenItem(actor, mutation.input);
          break;
        case "FLAG_HANDOFF":
          await this.flagHandoff(actor, mutation.input);
          break;
        case "CLEAR_HANDOFF":
          this.clearHandoff(actor, mutation.input);
          break;
        case "SET_DEPENDENCY":
          this.setDependency(actor, mutation.input);
          break;
        case "SET_NOTE":
          this.reportProgress(actor, mutation.input);
          break;
        case "UPDATE_ITEM":
          this.updateItem(actor, mutation.input);
          break;
        case "SET_STATUS":
          this.reportProgress(actor, mutation.input);
          break;
        case "REORDER_ITEMS":
          this.#mutateItems(actor, (transaction) => {
            for (const input of mutation.input) {
              this.#editItem(transaction, this.#requireItem(input), input);
            }
            return mutation.input[0].item_id;
          });
          break;
        case "UPDATE_PROJECT":
          this.updateProject(mutation.project_id, mutation.input);
          break;
        case "CREATE_PROJECT":
          this.createProject(mutation.input);
          break;
        case "MOVE_PROJECT":
          this.moveProject(mutation.input);
          break;
        case "DELETE_PROJECT":
          this.deleteProject(mutation.input.project_id);
          break;
        case "INITIALIZE_TIMEZONE":
          this.setTimezone(mutation.input.timezone, true);
          break;
        case "SET_TIMEZONE":
          this.setTimezone(mutation.input.timezone);
          break;
        case "SET_GUIDANCE":
          this.setGuidance(actor, mutation.input.text);
          break;
        case "CREATE_TOKEN": {
          const { label, scope, default_project_id } = mutation.input;
          createdToken = await this.createToken(
            label,
            scope,
            default_project_id,
          );
          break;
        }
        case "REVOKE_TOKEN":
          if (!this.revokeToken(mutation.input.token_id))
            throw new Error("Token not found");
          break;
      }
    } catch (cause) {
      const { code, message } = workspaceOperationError(cause);
      this.#send(socket, {
        type: "ERROR",
        requestId,
        error: { code, message },
      });
      return;
    }
    // Plaintext is returned only to the socket that created the token.
    this.#send(socket, { type: "ACK", requestId, createdToken });
  }

  #send(socket: WebSocket, message: WorkspaceMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    // The attachment survives eviction and keeps unicast replies from creating gaps in other tabs.
    const seq = ((socket.deserializeAttachment() as number | null) ?? 0) + 1;
    try {
      socket.send(JSON.stringify({ ...message, seq }));
    } catch {
      socket.close(1011, "Workspace message delivery failed");
      return;
    }
    socket.serializeAttachment(seq);
  }

  #broadcast(
    message: WorkspaceMessage,
    sockets = this.ctx.getWebSockets(),
  ): void {
    for (const socket of sockets) this.#send(socket, message);
  }

  #snapshot(): WorkspaceMessage {
    const now = Date.now();
    const counts = this.#childCounts();
    const items = this.#sql
      .exec<Item>(
        `SELECT * FROM items WHERE status NOT IN ('done', 'cancelled')
         OR (status = 'done' AND julianday(completed_at) >= julianday(?))
         ORDER BY depth, id`,
        new Date(now - DAY_MS).toISOString(),
      )
      .toArray()
      .filter((item) => isCanvasItem(item, now))
      .map((item) => ({
        ...item,
        progress: counts.get(item.id) ?? { done: 0, total: 0 },
      }));
    const settings = this.#readSettings();
    return {
      type: "SNAPSHOT",
      ...settings,
      projects: this.listProjects(),
      items,
      dependencies: this.listDependencies(),
    };
  }

  #childCounts(): Map<string, ChildCounts> {
    return new Map(
      this.#sql
        .exec<ChildCounts & { parent_id: string }>(
          `SELECT parent_id, SUM(status = 'done') AS done, COUNT(*) AS total
           FROM items WHERE parent_id IS NOT NULL AND status <> 'cancelled'
           GROUP BY parent_id`,
        )
        .toArray()
        .map(({ parent_id, done, total }) => [parent_id, { done, total }]),
    );
  }

  getSettings(): Settings {
    return this.#readSettings().settings;
  }

  #readSettings(): { settings: Settings; timezoneConfigured: boolean } {
    const values = Object.fromEntries(
      this.#sql
        .exec<Setting>("SELECT key, value FROM settings")
        .toArray()
        .map(({ key, value }) => [key, value]),
    );
    return {
      timezoneConfigured: values.timezone !== undefined,
      settings: {
        schema_version: Number(values.schema_version),
        timezone: values.timezone ?? "UTC",
        guidance: values.guidance,
        guidance_updated_at: values.guidance_updated_at ?? null,
      },
    };
  }

  async createToken(
    label: string,
    scope?: Token["scope"],
    default_project_id?: string | null,
  ): Promise<TokenMetadata & { token: string }> {
    const input = parseInput(CreateTokenSchema, {
      label,
      scope,
      default_project_id,
    });
    const workspaceId = this.ctx.id.name;
    if (!workspaceId) throw new Error("API tokens require a named workspace");
    const secret = newTokenSecret();
    const hash = await hashSecret(secret);
    if (
      input.default_project_id &&
      !this.#sql
        .exec("SELECT id FROM projects WHERE id = ?", input.default_project_id)
        .toArray().length
    ) {
      throw new Error("Default project not found");
    }
    const metadata = this.#sql
      .exec<TokenMetadata>(
        `INSERT INTO tokens (id, label, scope, default_project_id, secret_hash)
       VALUES (?, ?, ?, ?, ?) RETURNING ${TOKEN_METADATA_COLUMNS}`,
        crypto.randomUUID(),
        input.label,
        input.scope,
        input.default_project_id ?? null,
        hash,
      )
      .one();
    return { ...metadata, token: `heed_${workspaceId}_${secret}` };
  }

  listTokens(): TokenMetadata[] {
    return this.#sql
      .exec<TokenMetadata>(
        `SELECT ${TOKEN_METADATA_COLUMNS} FROM tokens ORDER BY created_at, id`,
      )
      .toArray();
  }

  revokeToken(id: string): boolean {
    return (
      this.#sql.exec("DELETE FROM tokens WHERE id = ?", id).rowsWritten > 0
    );
  }

  async verifyToken(
    secret: string,
  ): Promise<Extract<Actor, { kind: "agent" }> | null> {
    if (!isTokenSecret(secret)) return null;
    const hash = await hashSecret(secret);
    // Use the prefix for indexed lookup and compare the full digest in constant time.
    const token = this.#sql
      .exec<Token>(
        "SELECT * FROM tokens WHERE substr(secret_hash, 1, 16) = ?",
        hash.slice(0, 16),
      )
      .toArray()
      .find(({ secret_hash }) => equalSecretHashes(hash, secret_hash));
    if (!token) return null;

    const now = Date.now();
    if (
      token.last_used_at === null ||
      now - timestamp(token.last_used_at) >= TOKEN_USE_INTERVAL_MS
    ) {
      this.#sql.exec(
        "UPDATE tokens SET last_used_at = ? WHERE id = ?",
        new Date(now).toISOString(),
        token.id,
      );
    }
    return {
      kind: "agent",
      name: token.label,
      scope: token.scope,
      default_project_id: token.default_project_id,
    };
  }

  setTimezone(timezone: string, initializeOnly = false): void {
    const value = parseInput(TimezoneSchema, timezone);
    const updated = this.#sql.exec(
      `INSERT INTO settings (key, value) VALUES ('timezone', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value
       WHERE ? = 0 AND settings.value <> excluded.value`,
      value,
      Number(initializeOnly),
    );
    if (updated.rowsWritten > 0) this.#broadcastSettings();
  }

  getGuidance(): Guidance {
    const { guidance, guidance_updated_at } = this.getSettings();
    return { guidance, guidance_updated_at };
  }

  getHistory(input: HistoryQuery): HistoryPage {
    const { q, project, before, limit } = parseInput(HistoryQuerySchema, input);
    const separator = before?.indexOf("|") ?? -1;
    const at = separator < 0 ? before : before?.slice(0, separator);
    const id = separator < 0 ? null : before!.slice(separator + 1);
    const items = this.#sql
      .exec<HistoryItem>(
        `WITH history AS (
           SELECT i.*, strftime('%Y-%m-%dT%H:%M:%fZ',
             COALESCE(i.completed_at, i.updated_at)) AS history_at
           FROM items i JOIN projects p ON p.id = i.project_id
           WHERE i.status IN ('done', 'cancelled')
             AND (?1 IS NULL OR p.id = ?1 OR p.name = ?1)
             AND (?2 IS NULL OR instr(lower(i.title), lower(?2)) > 0
               OR instr(lower(i.note), lower(?2)) > 0)
         ), cursor AS (
           SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?3) AS at
         )
         SELECT history.* FROM history CROSS JOIN cursor
         WHERE ?3 IS NULL OR history_at < cursor.at
           OR (history_at = cursor.at AND id > ?4)
         ORDER BY history_at DESC, id
         LIMIT ?5`,
        project ?? null,
        q ?? null,
        at ?? null,
        id,
        limit + 1,
      )
      .toArray();
    const last = items[limit - 1];
    return {
      items: items.slice(0, limit),
      next_before:
        items.length > limit ? `${last.history_at}|${last.id}` : null,
    };
  }

  getItemEvents(input: ItemIdInput): Event[] {
    const data = parseInput(ItemIdSchema, input);
    this.#requireItem(data);
    return this.#sql
      .exec<Event>(
        "SELECT * FROM events WHERE item_id = ? ORDER BY julianday(at) DESC, id DESC",
        data.item_id,
      )
      .toArray();
  }

  getCanvas(input: z.input<typeof CanvasQuerySchema> = {}) {
    const { project, parent_id, query, include_done, limit } = parseInput(
      CanvasQuerySchema,
      input,
    );
    const { timezone, guidance, guidance_updated_at } = this.getSettings();
    const items = this.#sql
      .exec<CanvasRow>(
        `SELECT i.id, i.title, i.status, i.parent_id, i.ref_url, i.scheduled_on,
              i.time_at, i.completed_at, i.agent_name, p.name AS project
       FROM items i JOIN projects p ON p.id = i.project_id
       WHERE (?1 IS NULL OR p.id = ?1 OR p.name = ?1)
         AND (?2 OR i.parent_id IS ?3)
         AND (?4 IS NULL OR instr(lower(i.title), lower(?4)) > 0)
         AND (?5 OR i.status NOT IN ('done', 'cancelled'))
       ORDER BY i.status IN ('done', 'cancelled'), i.updated_at DESC, i.id
       LIMIT ?6`,
        project ?? null,
        Number(parent_id === undefined),
        parent_id ?? null,
        query ?? null,
        Number(include_done),
        Math.min(limit, MAX_CANVAS_ITEMS),
      )
      .toArray();
    const parentIds = [
      ...new Set(
        items.flatMap(({ parent_id }) =>
          parent_id === null ? [] : [parent_id],
        ),
      ),
    ];
    const ancestors =
      parentIds.length === 0
        ? []
        : this.#sql
            .exec<Pick<Item, "id" | "parent_id" | "scheduled_on">>(
              `WITH RECURSIVE ancestors(id, parent_id, scheduled_on) AS (
         SELECT id, parent_id, scheduled_on FROM items WHERE id IN (SELECT value FROM json_each(?))
         UNION
         SELECT i.id, i.parent_id, i.scheduled_on FROM items i
         JOIN ancestors a ON i.id = a.parent_id
       )
       SELECT * FROM ancestors`,
              JSON.stringify(parentIds),
            )
            .toArray();
    const bands = bandsFor(
      items,
      new Map(ancestors.map((item) => [item.id, item])),
      Date.now(),
      timezone,
    );
    return {
      guidance,
      guidance_updated_at,
      items: items.map(
        ({ id, title, project, status, parent_id, ref_url, agent_name }) => ({
          id,
          title,
          project,
          status,
          parent_id,
          ref_url,
          agent_name,
          band: bands.get(id) ?? null,
        }),
      ),
    };
  }

  setGuidance(actor: Actor, guidance: string): Guidance {
    requireSteering(parseInput(ActorSchema, actor), "change guidance");
    const value = parseInput(GuidanceTextSchema, guidance);
    const previous = this.#sql
      .exec<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'guidance_updated_at'",
      )
      .toArray()[0]?.value;
    // Agents use this timestamp to detect changes, including writes in the same millisecond.
    const now = Date.now();
    const updatedAt = new Date(
      previous ? Math.max(now, Date.parse(previous) + 1) : now,
    ).toISOString();
    this.#sql.exec(
      `INSERT INTO settings (key, value)
       VALUES ('guidance', ?), ('guidance_updated_at', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      value,
      updatedAt,
    );
    this.#broadcastSettings();
    return { guidance: value, guidance_updated_at: updatedAt };
  }

  #broadcastSettings(): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      this.#broadcast(
        { type: "SETTINGS_UPDATE", settings: this.getSettings() },
        sockets,
      );
    }
  }

  listProjects(): Project[] {
    return this.#sql
      .exec<Project>("SELECT * FROM projects ORDER BY sort, name")
      .toArray();
  }

  createProject(
    input: Pick<Project, "name"> & Partial<Omit<Project, "id" | "name">>,
  ): Project {
    const {
      name,
      color = null,
      sort = 0,
      hidden = 0,
    } = parseInput(CreateProjectSchema, input);
    const project = this.#sql
      .exec<Project>(
        `INSERT INTO projects (id, name, color, sort, hidden)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
        crypto.randomUUID(),
        name,
        color,
        sort,
        hidden,
      )
      .one();
    this.#broadcast({ type: "PROJECT_UPSERT", project });
    return project;
  }

  updateProject(id: string, input: Partial<Omit<Project, "id">>): Project {
    const patch = parseInput(UpdateProjectSchema, input);
    const current = this.#sql
      .exec<Project>("SELECT * FROM projects WHERE id = ?", id)
      .toArray()[0];
    if (!current) throw new Error("Project not found");

    const {
      name = current.name,
      color = current.color,
      sort = current.sort,
      hidden = current.hidden,
    } = patch;
    if (id === INBOX_PROJECT_ID && name !== current.name) {
      throw new Error("Inbox cannot be renamed");
    }
    if (
      name === current.name &&
      color === current.color &&
      sort === current.sort &&
      hidden === current.hidden
    ) {
      return current;
    }
    const project = this.#sql
      .exec<Project>(
        "UPDATE projects SET name = ?, color = ?, sort = ?, hidden = ? WHERE id = ? RETURNING *",
        name,
        color,
        sort,
        hidden,
        id,
      )
      .one();
    this.#broadcast({ type: "PROJECT_UPSERT", project });
    return project;
  }

  deleteProject(id: string): void {
    if (id === INBOX_PROJECT_ID) throw new Error("Inbox cannot be deleted");
    if (
      this.#sql
        .exec("SELECT 1 FROM items WHERE project_id = ? LIMIT 1", id)
        .toArray().length
    ) {
      throw new Error("Project still has items");
    }
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        "UPDATE tokens SET default_project_id = NULL WHERE default_project_id = ?",
        id,
      );
      const deleted = this.#sql.exec("DELETE FROM projects WHERE id = ?", id);
      if (deleted.rowsWritten === 0) throw new Error("Project not found");
    });
    this.#broadcast({ type: "PROJECT_REMOVE", project_id: id });
  }

  moveProject(input: z.input<typeof MoveProjectSchema>): void {
    const { project_id, direction } = parseInput(MoveProjectSchema, input);
    if (project_id === INBOX_PROJECT_ID)
      throw new Error("Inbox cannot be reordered");
    const projects = this.listProjects().sort(
      (a, b) => a.sort - b.sort || a.name.localeCompare(b.name),
    );
    const index = projects.findIndex(({ id }) => id === project_id);
    if (index < 0) throw new Error("Project not found");
    const step = direction === "up" ? -1 : 1;
    let destination = index + step;
    if (projects[destination]?.id === INBOX_PROJECT_ID) destination += step;
    if (!projects[destination]) return;

    const previousOrder = projects.map(({ sort }) => sort);
    const uniqueOrder = new Set(previousOrder).size === projects.length;
    [projects[index], projects[destination]] = [
      projects[destination],
      projects[index],
    ];
    const inbox = projects.findIndex(({ id }) => id === INBOX_PROJECT_ID);
    const inboxSort = projects[inbox].sort;
    const changed = this.ctx.storage.transactionSync(() =>
      projects.flatMap((project, position) => {
        // Older projects can share a sort value. Give those positions distinct
        // values while keeping Inbox in its existing slot.
        const sort = uniqueOrder
          ? previousOrder[position]
          : inboxSort + position - inbox;
        if (sort === project.sort) return [];
        this.#sql.exec(
          "UPDATE projects SET sort = ? WHERE id = ?",
          sort,
          project.id,
        );
        return [{ ...project, sort }];
      }),
    );
    for (const project of changed)
      this.#broadcast({ type: "PROJECT_UPSERT", project });
  }

  addItem(actor: Actor, input: AddItemInput): ItemOperationResult {
    const data = parseInput(AddItemSchema, input);
    return this.#mutateItems(actor, (mutation) => {
      const existing = data.external_key
        ? this.#findItem({ external_key: data.external_key })
        : undefined;
      if (existing) {
        this.#editItem(mutation, existing, data, {
          heartbeat: data.status === "active",
        });
        return existing.id;
      }

      const placement = this.#placement(mutation, data);
      const patch = this.#editPatch(mutation, data);
      if (patch.agent_name === undefined && mutation.actor.kind === "agent") {
        patch.agent_name = mutation.actor.name;
      }
      Object.assign(patch, placement);
      this.#applyStatus(mutation, patch, data.status);
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      const now = mutation.now.toISOString();
      const row = {
        ...patch,
        id,
        title: data.title,
        external_key: data.external_key ?? null,
        created_by: mutation.actor.kind,
        last_heartbeat_at: data.status === "active" ? now : null,
        created_at: now,
        updated_at: now,
      };
      const columns = Object.keys(row);
      const item = this.#sql
        .exec<Item>(
          `INSERT INTO items (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")}) RETURNING *`,
          ...Object.values(row),
        )
        .one();

      this.#appendEvent(mutation, id, "created", {
        status: item.status,
        note: item.note,
      });
      mutation.changes.push({ after: item });
      mutation.pruneEvents = true;
      return id;
    });
  }

  updateItem(actor: Actor, input: UpdateItemInput): ItemOperationResult {
    const data = parseInput(UpdateItemSchema, input);
    return this.#mutateItems(actor, (mutation) => {
      for (const field of STEER_FIELDS) {
        if (data[field] !== undefined) {
          requireSteering(
            mutation.actor,
            field === "unlock" ? "unlock fields" : `change ${field}`,
          );
        }
      }
      const item = this.#requireItem(data);
      this.#editItem(mutation, item, data);
      return item.id;
    });
  }

  reportProgress(
    actor: Actor,
    input: ReportProgressInput,
  ): ItemOperationResult {
    const data = parseInput(ReportProgressSchema, input);
    return this.#mutateItems(actor, (mutation) => {
      const item = this.#requireItem(data);
      const patch = this.#editPatch(mutation, data, item);
      this.#applyStatus(mutation, patch, data.status, item);
      this.#saveItem(mutation, item, patch, {
        heartbeat: actor.kind === "agent",
      });
      return item.id;
    });
  }

  async flagHandoff(
    actor: Actor,
    input: FlagHandoffInput,
  ): Promise<ItemOperationResult> {
    const data = parseInput(FlagHandoffSchema, input);
    let notifyAs: string | undefined;
    const result = this.#mutateItems(actor, (mutation) => {
      const item = this.#requireItem(data);
      if (data.notify === true && mutation.actor.kind === "agent") {
        notifyAs = mutation.actor.name;
      }
      this.#saveItem(
        mutation,
        item,
        { handoff: 1, handoff_note: data.note },
        {
          notify: notifyAs !== undefined,
        },
      );
      return item.id;
    });
    if (notifyAs !== undefined) {
      await this.#notifyHandoff(notifyAs, data.item_id, data.note);
    }
    return result;
  }

  clearHandoff(actor: Actor, input: ItemIdInput): ItemOperationResult {
    const data = parseInput(ItemIdSchema, input);
    return this.#mutateItems(actor, (mutation) => {
      requireSteering(mutation.actor, "clear a handoff");
      const item = this.#requireItem(data);
      this.#saveItem(mutation, item, { handoff: 0, handoff_note: null });
      return item.id;
    });
  }

  reopenItem(actor: Actor, input: ReopenItemInput): ItemOperationResult {
    const data = parseInput(ReopenItemSchema, input);
    return this.#mutateItems(actor, (mutation) => {
      const item = this.#requireItem(data);
      if (!isTerminalStatus(item.status)) {
        throw new Error("Only done or cancelled items can be reopened");
      }
      const patch: ItemPatch = {
        status: "queued",
        completed_at: null,
        completed_band: null,
        reopen_count: item.reopen_count + 1,
        reopen_reason: data.reason,
      };
      this.#scheduleToday(mutation, patch, item);
      this.#saveItem(mutation, item, patch, { reopened: true });
      return item.id;
    });
  }

  deleteItem(actor: Actor, input: ItemIdInput): ItemOperationResult {
    const data = parseInput(ItemIdSchema, input);
    return this.#mutateItems(actor, (mutation) => {
      if (mutation.actor.kind !== "human") {
        throw new Error(
          "Only a human can hard-delete items. Agents can cancel them.",
        );
      }
      const item = this.#requireItem(data);
      const removed = [item, ...this.#descendants(item.id)];
      mutation.changes.push(...removed.map((before) => ({ before })));
      if (this.ctx.getWebSockets().length > 0) {
        const ids = new Set(removed.map(({ id }) => id));
        mutation.removedDependencies = this.listDependencies().filter(
          ({ item_id, blocked_by_id }) =>
            ids.has(item_id) || ids.has(blocked_by_id),
        );
      }
      this.#sql.exec("DELETE FROM items WHERE id = ?", item.id);
      mutation.pruneEvents = true;
      return item.id;
    });
  }

  listDependencies(): Dependency[] {
    return this.#sql
      .exec<Dependency>(
        "SELECT item_id, blocked_by_id FROM dependencies ORDER BY item_id, blocked_by_id",
      )
      .toArray();
  }

  setDependency(
    actor: Actor,
    input: SetDependencyInput,
  ): DependencyOperationResult {
    const data = parseInput(SetDependencySchema, input);
    const { item_id, blocked_by_id, action } = data;
    let changed = false;
    const result = this.#mutateItems(actor, (mutation) => {
      for (const id of [item_id, blocked_by_id]) {
        const item = this.#requireItem({ item_id: id });
        if (action === "add" && item.status === "cancelled") {
          throw new Error(`Cannot add a dependency for cancelled item ${id}`);
        }
      }
      if (action === "add") {
        this.#rejectDependencyCycle(item_id, blocked_by_id);
        changed =
          this.#sql.exec(
            "INSERT INTO dependencies (item_id, blocked_by_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
            item_id,
            blocked_by_id,
          ).rowsWritten > 0;
      } else {
        changed =
          this.#sql.exec(
            "DELETE FROM dependencies WHERE item_id = ? AND blocked_by_id = ?",
            item_id,
            blocked_by_id,
          ).rowsWritten > 0;
      }
      mutation.pruneEvents = changed;
      return item_id;
    });
    if (changed) {
      this.#broadcast({
        type: action === "add" ? "DEPENDENCY_ADD" : "DEPENDENCY_REMOVE",
        dependency: { item_id, blocked_by_id },
      });
    }
    return { ...result, dependency: changed ? data : null };
  }

  #rejectDependencyCycle(itemId: string, blockedById: string): void {
    const previous = new Map<string, string | undefined>([
      [blockedById, undefined],
    ]);
    const pending = [blockedById];
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index];
      if (current === itemId) {
        const path: string[] = [];
        for (
          let id: string | undefined = current;
          id !== undefined;
          id = previous.get(id)
        ) {
          path.push(id);
        }
        path.push(itemId);
        throw new Error(
          `Dependency would create a cycle: ${path.reverse().join(" -> ")}`,
        );
      }
      const blockers = this.#sql.exec<Pick<Dependency, "blocked_by_id">>(
        "SELECT blocked_by_id FROM dependencies WHERE item_id = ?",
        current,
      );
      for (const { blocked_by_id } of blockers) {
        if (previous.has(blocked_by_id)) continue;
        previous.set(blocked_by_id, current);
        pending.push(blocked_by_id);
      }
    }
  }

  async #notifyHandoff(
    actorName: string,
    itemId: string,
    note: string,
  ): Promise<void> {
    const subscriptions = this.#sql
      .exec<{ endpoint: string; keys: string }>(
        "SELECT endpoint, keys FROM push_subscriptions",
      )
      .toArray();
    if (!subscriptions.length) return;

    const handoffId = this.#latestHandoffId(itemId);
    const item = this.#requireItem({ item_id: itemId });
    const data = {
      title: item.title,
      body: note,
      url: `/?item=${encodeURIComponent(itemId)}`,
    };
    const vapid = {
      subject: this.env.VAPID_SUBJECT,
      publicKey: this.env.VAPID_SERVER_PUBLIC_KEY,
      privateKey: this.env.VAPID_SERVER_PRIVATE_KEY,
    };

    const attempts = await Promise.allSettled(
      subscriptions.map(async ({ endpoint, keys }) => {
        const subscription: PushSubscription = {
          endpoint,
          expirationTime: null,
          keys: JSON.parse(keys),
        };
        const payload = await buildPushPayload({ data }, subscription, vapid);
        await this.ctx.storage.sync();

        // A handoff or subscription can change while the payload is prepared.
        const stillSubscribed = this.#sql
          .exec(
            "SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND keys = ?",
            endpoint,
            keys,
          )
          .toArray().length;
        if (!stillSubscribed || this.#latestHandoffId(itemId) !== handoffId)
          return;

        const response = await fetch(endpoint, {
          ...payload,
          redirect: "error",
        });
        void response.body?.cancel().catch(() => {});
        if (response.status !== 201) throw new Error("Web Push rejected");
        return true;
      }),
    );
    if (
      attempts.some(
        (attempt) => attempt.status === "fulfilled" && attempt.value,
      )
    ) {
      // The item may have been deleted after the request reached the provider.
      this.#sql.exec(
        `INSERT INTO events (item_id, at, actor, kind, detail)
         SELECT id, ?, ?, 'notified', ? FROM items WHERE id = ?`,
        new Date().toISOString(),
        actorName,
        JSON.stringify(data),
        itemId,
      );
    } else if (attempts.some((attempt) => attempt.status === "rejected")) {
      throw new Error("Handoff recorded, but Web Push failed");
    }
  }

  #latestHandoffId(itemId: string): number | undefined {
    return this.#sql
      .exec<{ id: number }>(
        "SELECT id FROM events WHERE item_id = ? AND kind = 'handoff' ORDER BY id DESC LIMIT 1",
        itemId,
      )
      .toArray()[0]?.id;
  }

  #mutateItems(
    input: Actor,
    operation: (mutation: Mutation) => string,
  ): ItemOperationResult {
    const actor = parseInput(ActorSchema, input);
    const { mutation, result } = this.ctx.storage.transactionSync(() => {
      const { timezone, guidance_updated_at } = this.getSettings();
      const mutation: Mutation = {
        actor,
        now: new Date(),
        timezone,
        changes: [],
        ignored: new Set(),
        pruneEvents: false,
      };
      const item_id = operation(mutation);
      if (mutation.pruneEvents) this.#pruneEvents(mutation.now);
      return {
        mutation,
        result: {
          item_id,
          items: mutation.changes.map(({ before, after }) => after ?? before),
          ignored_fields: [...mutation.ignored],
          guidance_updated_at,
        },
      };
    });
    this.#broadcastItemChanges(mutation);
    return result;
  }

  #broadcastItemChanges(mutation: Mutation): void {
    const { changes, now, removedDependencies, throttledHeartbeat } = mutation;
    if (changes.length === 0 && !throttledHeartbeat) return;
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;

    const time = now.getTime();
    const upserts = new Map<string, Item>();
    const removed = new Set<string>();
    const parents = new Set<string>();
    for (const dependency of removedDependencies ?? []) {
      this.#broadcast({ type: "DEPENDENCY_REMOVE", dependency }, sockets);
    }
    for (const { before, after } of changes) {
      if (after && isCanvasItem(after, time)) {
        upserts.set(after.id, after);
      } else if (before && (!after || isCanvasItem(before, time))) {
        removed.add(before.id);
        this.#broadcast({ type: "ITEM_REMOVE", item_id: before.id }, sockets);
      }

      const oldParent =
        before?.status === "cancelled" ? null : (before?.parent_id ?? null);
      const newParent =
        after?.status === "cancelled" ? null : (after?.parent_id ?? null);
      if (
        oldParent !== newParent ||
        (before?.status === "done") !== (after?.status === "done")
      ) {
        if (oldParent) parents.add(oldParent);
        if (newParent) parents.add(newParent);
      }
    }
    if (throttledHeartbeat && isCanvasItem(throttledHeartbeat, time)) {
      upserts.set(throttledHeartbeat.id, throttledHeartbeat);
    }
    for (const id of parents) {
      if (upserts.has(id) || removed.has(id)) continue;
      const parent = this.#findItem({ item_id: id });
      if (parent && isCanvasItem(parent, time)) upserts.set(id, parent);
    }
    if (upserts.size === 0) return;
    const counts = this.#childCounts();
    for (const item of upserts.values()) {
      this.#broadcast(
        {
          type: "ITEM_UPSERT",
          item: {
            ...item,
            progress: counts.get(item.id) ?? { done: 0, total: 0 },
          },
        },
        sockets,
      );
    }
  }

  #findItem({
    item_id,
    external_key,
  }: {
    item_id?: string;
    external_key?: string;
  }): Item | undefined {
    return (
      item_id !== undefined
        ? this.#sql.exec<Item>("SELECT * FROM items WHERE id = ?", item_id)
        : this.#sql.exec<Item>(
            "SELECT * FROM items WHERE external_key = ?",
            external_key!,
          )
    ).toArray()[0];
  }

  #requireItem(selector: { item_id?: string; external_key?: string }): Item {
    const item = this.#findItem(selector);
    if (!item) throw new Error("Item not found");
    return item;
  }

  #descendants(id: string): Item[] {
    return this.#sql
      .exec<Item>(
        `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM items WHERE parent_id = ?
         UNION ALL
         SELECT items.id FROM items JOIN descendants ON items.parent_id = descendants.id
       )
       SELECT items.* FROM items JOIN descendants USING (id) ORDER BY depth, id`,
        id,
      )
      .toArray();
  }

  #placement(mutation: Mutation, input: ItemEdit, current?: Item) {
    const parent_id =
      input.parent_id === undefined
        ? (current?.parent_id ?? null)
        : input.parent_id;
    const parent =
      parent_id === null
        ? undefined
        : this.#requireItem({ item_id: parent_id });
    const defaultProject =
      mutation.actor.kind === "agent"
        ? mutation.actor.default_project_id
        : null;
    const project_id =
      parent?.project_id ??
      input.project ??
      current?.project_id ??
      defaultProject ??
      INBOX_PROJECT_ID;

    if (
      !parent &&
      project_id !== current?.project_id &&
      !this.#sql
        .exec("SELECT 1 FROM projects WHERE id = ?", project_id)
        .toArray().length
    ) {
      throw new Error("Project not found");
    }
    const depth = parent ? parent.depth + 1 : 1;
    if (depth > 3) throw new Error(DEPTH_ERROR);
    return { parent_id, project_id, depth };
  }

  #editItem(
    mutation: Mutation,
    item: Item,
    input: ItemEdit,
    options?: { heartbeat: boolean },
  ): void {
    const patch = this.#editPatch(mutation, input, item);
    const move =
      input.parent_id !== undefined || input.project !== undefined
        ? this.#moveItem(mutation, item, input)
        : undefined;
    Object.assign(patch, move?.placement);

    this.#applyStatus(mutation, patch, input.status, item);
    this.#saveItem(mutation, item, patch, options);
    if (!move) return;

    const { placement, descendants } = move;
    for (const child of descendants) {
      this.#saveItem(mutation, child, {
        depth: child.depth + placement.depth - item.depth,
        project_id: placement.project_id,
      });
    }
  }

  #moveItem(mutation: Mutation, item: Item, input: ItemEdit) {
    // An add retry may repeat its existing placement. Any actual project move needs steering.
    if (
      input.project !== undefined &&
      input.project !== item.project_id &&
      !input.parent_id
    ) {
      requireSteering(mutation.actor, "change project");
    }
    if (input.parent_id === item.id)
      throw new Error("Parent would create an item cycle");
    const descendants =
      input.parent_id !== undefined && input.parent_id !== item.parent_id
        ? this.#descendants(item.id)
        : undefined;
    if (descendants?.some((child) => child.id === input.parent_id)) {
      throw new Error("Parent would create an item cycle");
    }

    const placement = this.#placement(mutation, input, item);
    const changesProject = placement.project_id !== item.project_id;
    if (changesProject) requireSteering(mutation.actor, "change project");
    if (
      descendants?.some(
        (child) => child.depth + placement.depth - item.depth > 3,
      )
    ) {
      throw new Error(DEPTH_ERROR);
    }
    return {
      placement,
      descendants:
        descendants ?? (changesProject ? this.#descendants(item.id) : []),
    };
  }

  #editPatch(mutation: Mutation, input: ItemEdit, item?: Item): ItemPatch {
    const patch: ItemPatch = {};
    for (const field of [
      "title",
      "ref_url",
      "time_type",
      "time_at",
      "note",
    ] as const) {
      const value = input[field];
      if (value !== undefined) Object.assign(patch, { [field]: value });
    }
    if (input.tags !== undefined) patch.tags = JSON.stringify(input.tags);
    if (input.hidden !== undefined) patch.hidden = input.hidden ? 1 : 0;
    if (input.agent_name !== undefined) patch.agent_name = input.agent_name;
    const locked = LockableFieldSchema.array().parse(
      JSON.parse(item?.locked_fields ?? "[]"),
    );
    const nextLocks = new Set(locked);
    for (const field of LockableFieldSchema.options) {
      const value = input[field];
      if (value === undefined) continue;
      if (isReport(mutation.actor) && nextLocks.has(field)) {
        mutation.ignored.add(field);
        continue;
      }
      Object.assign(patch, {
        [field]: field === "layout_pos" ? JSON.stringify(value) : value,
      });
      if (!isReport(mutation.actor)) nextLocks.add(field);
    }
    if (input.unlock !== undefined) nextLocks.delete(input.unlock);
    const serialized = JSON.stringify([...nextLocks]);
    if (serialized !== JSON.stringify(locked)) patch.locked_fields = serialized;
    return patch;
  }

  #applyStatus(
    mutation: Mutation,
    patch: ItemPatch,
    status?: Status,
    item?: Item,
  ): void {
    if (status === undefined || status === (item?.status ?? "queued")) return;
    if (item && isTerminalStatus(item.status) && !isTerminalStatus(status)) {
      throw new Error(
        "Use reopenItem with a reason to reopen a done or cancelled item",
      );
    }
    patch.status = status;
    if (status === "done") {
      const placement = { ...item, ...patch };
      const ancestors = new Map<string, Item>();
      let parentId = placement.parent_id;
      while (parentId) {
        const parent = this.#findItem({ item_id: parentId });
        if (!parent) break;
        ancestors.set(parentId, parent);
        parentId = parent.parent_id;
      }
      patch.completed_at = mutation.now.toISOString();
      patch.completed_band = completionBand(
        {
          id: item?.id ?? "",
          parent_id: placement.parent_id ?? null,
          scheduled_on: placement.scheduled_on ?? null,
          time_at: placement.time_at ?? null,
          completed_at: null,
          status: item?.status ?? "queued",
        },
        ancestors,
        mutation.now.getTime(),
        mutation.timezone,
      );
    } else if (item?.status === "done") {
      patch.completed_at = null;
      patch.completed_band = null;
    }

    const schedule =
      patch.scheduled_on === undefined
        ? item?.scheduled_on
        : patch.scheduled_on;
    if (status === "active" && schedule == null)
      this.#scheduleToday(mutation, patch, item);
  }

  #scheduleToday(mutation: Mutation, patch: ItemPatch, item?: Item): void {
    if (
      isReport(mutation.actor) &&
      item &&
      LockableFieldSchema.array()
        .parse(JSON.parse(item.locked_fields))
        .includes("scheduled_on")
    ) {
      mutation.ignored.add("scheduled_on");
    } else {
      patch.scheduled_on = today(mutation);
    }
  }

  #saveItem(
    mutation: Mutation,
    item: Item,
    patch: ItemPatch,
    options: { heartbeat?: boolean; notify?: boolean; reopened?: boolean } = {},
  ): void {
    const changes = (Object.keys(patch) as (keyof ItemPatch)[]).filter(
      (field) => patch[field] !== item[field],
    );
    const meaningful = changes.length > 0;
    const now = mutation.now.toISOString();
    if (
      options.heartbeat &&
      (meaningful ||
        item.last_heartbeat_at === null ||
        mutation.now.getTime() - timestamp(item.last_heartbeat_at) >=
          HEARTBEAT_INTERVAL_MS)
    ) {
      changes.push("last_heartbeat_at");
      patch.last_heartbeat_at = now;
    }

    let updated = item;
    if (changes.length > 0) {
      const assignments = changes.map((field) => `${field} = ?`);
      const values = changes.map((field) => patch[field]!);
      if (meaningful) {
        assignments.push("updated_at = ?");
        values.push(now);
      }
      updated = this.#sql
        .exec<Item>(
          `UPDATE items SET ${assignments.join(", ")} WHERE id = ? RETURNING *`,
          ...values,
          item.id,
        )
        .one();
      mutation.changes.push({ before: item, after: updated });
    } else if (options.heartbeat) {
      mutation.throttledHeartbeat = { ...item, last_heartbeat_at: now };
    }
    if (meaningful || options.notify) mutation.pruneEvents = true;

    if (item.status !== updated.status) {
      this.#appendEvent(mutation, item.id, "status", {
        old: item.status,
        new: updated.status,
      });
    }
    if (item.note !== updated.note) {
      this.#appendEvent(mutation, item.id, "note", {
        old: item.note,
        new: updated.note,
      });
    }
    if (
      item.handoff !== updated.handoff ||
      item.handoff_note !== updated.handoff_note ||
      options.notify
    ) {
      this.#appendEvent(mutation, item.id, "handoff", {
        handoff: Boolean(updated.handoff),
        note: updated.handoff_note,
        notify: options.notify ?? false,
      });
    }
    if (options.reopened) {
      this.#appendEvent(mutation, item.id, "reopened", {
        reason: updated.reopen_reason,
      });
    }
    const moves = MOVE_FIELDS.filter((field) => item[field] !== updated[field]);
    if (moves.length > 0) {
      this.#appendEvent(
        mutation,
        item.id,
        "moved",
        Object.fromEntries(
          moves.map((field) => [
            field,
            { old: item[field], new: updated[field] },
          ]),
        ),
      );
    }
  }

  #appendEvent(
    mutation: Mutation,
    id: string,
    kind: EventKind,
    detail: object,
  ): void {
    this.#sql.exec(
      "INSERT INTO events (item_id, at, actor, kind, detail) VALUES (?, ?, ?, ?, ?)",
      id,
      mutation.now.toISOString(),
      mutation.actor.kind === "human" ? "human" : mutation.actor.name,
      kind,
      JSON.stringify(detail),
    );
  }

  #pruneEvents(now: Date): void {
    const lastPrune = this.#sql
      .exec<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'events_pruned_at'",
      )
      .toArray()[0]?.value;
    if (lastPrune && now.getTime() - timestamp(lastPrune) < DAY_MS) return;

    const cutoff = new Date(now.getTime() - 90 * DAY_MS).toISOString();
    this.#sql.exec(
      "DELETE FROM events WHERE julianday(at) < julianday(?)",
      cutoff,
    );
    this.#sql.exec(
      `INSERT INTO settings (key, value) VALUES ('events_pruned_at', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      now.toISOString(),
    );
  }
}
