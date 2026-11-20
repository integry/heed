import { DurableObject } from "cloudflare:workers";
import { z, type ZodType } from "zod";
import { bandsFor } from "../shared/derived-state";
import {
  GuidanceTextSchema,
  INBOX_PROJECT_ID,
  ProjectSchema,
  TimezoneSchema,
} from "../shared/workspace";
import type {
  Guidance,
  Item,
  Project,
  Setting,
  Settings,
} from "../shared/workspace";
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

export const DEFAULT_WORKSPACE_ID = "default";

export function getWorkspaceStub(env: Env, workspaceId = DEFAULT_WORKSPACE_ID) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
}

function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues[0].message);
  return result.data;
}

export class Workspace extends DurableObject<Env> {
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
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

  setGuidance(guidance: string): Guidance {
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
    const deleted = this.#sql.exec("DELETE FROM projects WHERE id = ?", id);
    if (deleted.rowsWritten === 0) throw new Error("Project not found");
  }
}
