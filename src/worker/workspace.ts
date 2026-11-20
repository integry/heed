import { DurableObject } from "cloudflare:workers";
import type { ZodType } from "zod";
import {
  GuidanceTextSchema,
  INBOX_PROJECT_ID,
  ProjectSchema,
  TimezoneSchema,
} from "../shared/workspace";
import type { Guidance, Project, Setting, Settings } from "../shared/workspace";
import { migrateWorkspace } from "./workspace-migrations";

const projectUpdateSchema = ProjectSchema.omit({ id: true }).partial().strict();
const projectCreateSchema = projectUpdateSchema.required({ name: true });

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
