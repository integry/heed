import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { PushSubscription } from "@block65/webcrypto-web-push";
import { DurableObject } from "cloudflare:workers";
import { z, type ZodType } from "zod";
import { bandsFor } from "../shared/derived-state";
import {
  ActorSchema,
  AddItemSchema,
  FlagHandoffSchema,
  ItemIdSchema,
  LockableFieldSchema,
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
  CreateTokenSchema,
  DEFAULT_WORKSPACE_ID,
  GuidanceTextSchema,
  INBOX_PROJECT_ID,
  ProjectSchema,
  TimezoneSchema,
} from "../shared/workspace";
import type {
  Dependency,
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

const projectUpdateSchema = ProjectSchema.omit({ id: true }).partial().strict();
const projectCreateSchema = projectUpdateSchema.required({ name: true });
const MAX_CANVAS_ITEMS = 50;
const canvasQuerySchema = z
  .object({
    project: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    query: z.string().optional(),
    include_done: z.boolean().default(false),
    limit: z.int().positive().default(MAX_CANVAS_ITEMS),
  })
  .strict();

type CanvasRow = Pick<
  Item,
  | "id"
  | "title"
  | "status"
  | "parent_id"
  | "ref_url"
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
type Mutation = {
  actor: Actor;
  now: Date;
  timezone: string;
  items: Item[];
  ignored: Set<LockableField>;
  pruneEvents: boolean;
};

function isReport(actor: Actor): boolean {
  return actor.kind === "agent" && actor.scope === "report";
}

function isTerminalStatus(status: Status): boolean {
  return status === "done" || status === "cancelled";
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
    void ctx.blockConcurrencyWhile(async () => {
      migrateWorkspace(ctx.storage);
    });
  }

  getSettings(): Settings {
    const values = Object.fromEntries(
      this.#sql
        .exec<Setting>("SELECT key, value FROM settings")
        .toArray()
        .map(({ key, value }) => [key, value]),
    );
    return {
      schema_version: Number(values.schema_version),
      timezone: values.timezone,
      guidance: values.guidance,
      guidance_updated_at: values.guidance_updated_at ?? null,
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

  setTimezone(timezone: string): void {
    const value = parseInput(TimezoneSchema, timezone);
    this.#sql.exec(
      "UPDATE settings SET value = ? WHERE key = 'timezone' AND value <> ?",
      value,
      value,
    );
  }

  getGuidance(): Guidance {
    const { guidance, guidance_updated_at } = this.getSettings();
    return { guidance, guidance_updated_at };
  }

  getCanvas(input: z.input<typeof canvasQuerySchema> = {}) {
    const { project, parent_id, query, include_done, limit } = parseInput(
      canvasQuerySchema,
      input,
    );
    const { timezone, guidance, guidance_updated_at } = this.getSettings();
    const items = this.#sql
      .exec<CanvasRow>(
        `SELECT i.id, i.title, i.status, i.parent_id, i.ref_url, i.scheduled_on,
              i.time_at, i.completed_at, p.name AS project
       FROM items i JOIN projects p ON p.id = i.project_id
       WHERE (?1 IS NULL OR p.id = ?1 OR p.name = ?1)
         AND (?2 OR i.parent_id IS ?3)
         AND (?4 IS NULL OR instr(lower(i.title), lower(?4)) > 0)
         AND (?5 OR i.status NOT IN ('done', 'cancelled'))
       ORDER BY i.updated_at DESC, i.id
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
        ({ id, title, project, status, parent_id, ref_url }) => ({
          id,
          title,
          project,
          status,
          parent_id,
          ref_url,
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
    return { guidance: value, guidance_updated_at: updatedAt };
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
    } = parseInput(projectCreateSchema, input);
    return this.#sql
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
  }

  updateProject(id: string, input: Partial<Omit<Project, "id">>): Project {
    const patch = parseInput(projectUpdateSchema, input);
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
    return this.#sql
      .exec<Project>(
        "UPDATE projects SET name = ?, color = ?, sort = ?, hidden = ? WHERE id = ? RETURNING *",
        name,
        color,
        sort,
        hidden,
        id,
      )
      .one();
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
      this.#applyStatus(mutation, patch, data.status);
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      const now = mutation.now.toISOString();
      const row = {
        ...placement,
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
      mutation.items.push(item);
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
      this.#saveItem(mutation, item, patch, { heartbeat: true });
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
      mutation.items.push(item, ...this.#descendants(item.id));
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
    return this.ctx.storage.transactionSync(() => {
      const { timezone, guidance_updated_at } = this.getSettings();
      const mutation: Mutation = {
        actor,
        now: new Date(),
        timezone,
        items: [],
        ignored: new Set(),
        pruneEvents: false,
      };
      const item_id = operation(mutation);
      if (mutation.pruneEvents) this.#pruneEvents(mutation.now);
      return {
        item_id,
        items: mutation.items,
        ignored_fields: [...mutation.ignored],
        guidance_updated_at,
      };
    });
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
    if (status === "done") patch.completed_at = mutation.now.toISOString();
    else if (item?.status === "done") patch.completed_at = null;

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
      mutation.items.push(updated);
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
