import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  INBOX_PROJECT_ID,
  MAX_GUIDANCE_LENGTH,
  SettingsSchema,
} from "@heedwork/core";
import { getWorkspaceStub } from "./workspace";

function newWorkspace() {
  return getWorkspaceStub(env, crypto.randomUUID());
}

it("isolates explicitly named workspaces", async () => {
  const first = newWorkspace();
  const second = newWorkspace();
  await first.createProject({ name: "Engineering" });
  expect(await second.listProjects()).toEqual([
    expect.objectContaining({ id: INBOX_PROJECT_ID }),
  ]);
});

it("migrates a fresh object and seeds Inbox", async () => {
  const stub = newWorkspace();
  const settings = await stub.getSettings();
  expect(SettingsSchema.parse(settings)).toEqual({
    schema_version: 5,
    timezone: "UTC",
    guidance: "",
    guidance_updated_at: null,
  });
  expect(await stub.listProjects()).toEqual([
    { id: INBOX_PROJECT_ID, name: "Inbox", color: null, sort: 0, hidden: 0 },
  ]);

  const schema = await runInDurableObject(stub, (_, { storage: { sql } }) =>
    sql
      .exec(
        `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      )
      .toArray(),
  );
  expect(schema.map(({ name }) => name)).toEqual([
    "dependencies",
    "events",
    "idx_events_item",
    "idx_tokens_hash_prefix",
    "items",
    "projects",
    "push_rate_limits",
    "push_subscriptions",
    "settings",
    "tokens",
  ]);
});

it("keeps the migration and stored data intact across an eviction", async () => {
  const stub = newWorkspace();
  await stub.setTimezone("Europe/Tallinn");
  const guidance = await stub.setGuidance(
    { kind: "human" },
    "Start with billing",
  );
  const project = await stub.createProject({ name: "Billing" });
  await evictDurableObject(stub);

  expect(await stub.getSettings()).toEqual({
    schema_version: 5,
    timezone: "Europe/Tallinn",
    ...guidance,
  });
  expect(await stub.listProjects()).toEqual([
    project,
    expect.objectContaining({ id: INBOX_PROJECT_ID }),
  ]);
});

it("creates, lists, updates and deletes projects", async () => {
  const stub = newWorkspace();
  const project = await stub.createProject({ name: "Dev", color: "#0033ff" });
  expect(project).toEqual({
    id: expect.any(String),
    name: "Dev",
    color: "#0033ff",
    sort: 0,
    hidden: 0,
  });
  const updated = await stub.updateProject(project.id, {
    name: "Engineering",
    sort: -1,
    hidden: 1,
  });
  expect(updated).toEqual({
    ...project,
    name: "Engineering",
    sort: -1,
    hidden: 1,
  });
  expect(await stub.listProjects()).toEqual([
    updated,
    expect.objectContaining({ id: INBOX_PROJECT_ID }),
  ]);
  expect(await stub.updateProject(project.id, { color: null })).toEqual({
    ...updated,
    color: null,
  });
  await stub.deleteProject(project.id);
  expect(await stub.listProjects()).toEqual([
    expect.objectContaining({ id: INBOX_PROJECT_ID }),
  ]);
  // Assert expected throws inside the object to avoid duplicate RPC rejections
  // from the Workers Vitest harness.
  await runInDurableObject(stub, (workspace) => {
    expect(() => workspace.updateProject(project.id, {})).toThrow(
      "Project not found",
    );
    expect(() => workspace.deleteProject(project.id)).toThrow(
      "Project not found",
    );
  });
});

it("rejects duplicate project names and protects Inbox", async () => {
  const stub = newWorkspace();
  const dev = await stub.createProject({ name: "Dev" });
  await runInDurableObject(stub, (workspace) => {
    expect(() => workspace.createProject({ name: "Dev" })).toThrow(
      "UNIQUE constraint",
    );
    expect(() => workspace.updateProject(dev.id, { name: "Inbox" })).toThrow(
      "UNIQUE constraint",
    );
    expect(() =>
      workspace.updateProject(INBOX_PROJECT_ID, { name: "Other" }),
    ).toThrow("Inbox cannot be renamed");
    expect(() => workspace.deleteProject(INBOX_PROJECT_ID)).toThrow(
      "Inbox cannot be deleted",
    );
  });
  expect(
    await stub.updateProject(INBOX_PROJECT_ID, { hidden: 1 }),
  ).toMatchObject({
    name: "Inbox",
    hidden: 1,
  });
});

it("enforces project foreign keys and rejects deleting a project with items", async () => {
  const stub = newWorkspace();
  const project = await stub.createProject({ name: "Dev" });
  await runInDurableObject(stub, (workspace, { storage: { sql } }) => {
    expect(() =>
      sql.exec(
        "INSERT INTO items (id, project_id, title) VALUES ('orphan', 'missing', 'Orphan')",
      ),
    ).toThrow("FOREIGN KEY constraint");
    sql.exec(
      "INSERT INTO items (id, project_id, title) VALUES ('item', ?, 'Task')",
      project.id,
    );
    expect(() => workspace.deleteProject(project.id)).toThrow(
      "Project still has items",
    );
  });
  expect(await stub.listProjects()).toContainEqual(project);
});

it("persists guidance and timestamps within the character limit", async () => {
  const stub = newWorkspace();
  expect(await stub.getGuidance()).toEqual({
    guidance: "",
    guidance_updated_at: null,
  });

  const text = "🙂".repeat(MAX_GUIDANCE_LENGTH);
  const saved = await stub.setGuidance({ kind: "human" }, text);
  expect(saved.guidance).toBe(text);
  expect(new Date(saved.guidance_updated_at!).toISOString()).toBe(
    saved.guidance_updated_at,
  );
  await runInDurableObject(stub, (workspace) => {
    expect(() => workspace.setGuidance({ kind: "human" }, text + "!")).toThrow(
      "at most 2000 characters",
    );
  });
  expect(await stub.getGuidance()).toEqual(saved);

  const cleared = await stub.setGuidance({ kind: "human" }, "");
  expect(cleared.guidance).toBe("");
  expect(cleared.guidance_updated_at! > saved.guidance_updated_at!).toBe(true);
  expect(await stub.getGuidance()).toEqual(cleared);
});

it("accepts IANA timezone names and rejects invalid names and offsets", async () => {
  const stub = newWorkspace();
  await stub.setTimezone("Asia/Kathmandu");
  await runInDurableObject(stub, (workspace) => {
    expect(() => workspace.setTimezone("Nowhere/Imaginary")).toThrow(
      "IANA timezone",
    );
    expect(() => workspace.setTimezone("+05:45")).toThrow("IANA timezone");
  });
  expect((await stub.getSettings()).timezone).toBe("Asia/Kathmandu");
});

it("returns a compact canvas with bands inherited from ancestors outside the query", async () => {
  const stub = newWorkspace();
  const guidance = await stub.setGuidance(
    { kind: "human" },
    "Start with billing",
  );
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    sql.exec(`
      INSERT INTO items (id, project_id, title, scheduled_on)
      VALUES ('goal', 'inbox', 'Billing', '2000-01-01');
      INSERT INTO items (id, project_id, title, parent_id, depth, ref_url, agent_name)
      VALUES ('task', 'inbox', 'Payment flow', 'goal', 2, NULL, NULL),
             ('child', 'inbox', 'Repair retries', 'task', 3, 'https://example.com/pull/1', 'Builder');
      INSERT INTO items (id, project_id, title, status, completed_at)
      VALUES ('archive', 'inbox', 'Retry tests', 'done', '2000-01-01 00:00:00');
    `);
  });

  expect(
    await stub.getCanvas({
      project: "Inbox",
      query: "RETRIES",
      parent_id: "task",
    }),
  ).toEqual({
    ...guidance,
    items: [
      {
        id: "child",
        title: "Repair retries",
        project: "Inbox",
        status: "queued",
        parent_id: "task",
        ref_url: "https://example.com/pull/1",
        agent_name: "Builder",
        band: "today",
      },
    ],
  });
  expect(
    (await stub.getCanvas({ parent_id: null })).items.map(({ id }) => id),
  ).toEqual(["goal"]);
  expect(
    (await stub.getCanvas({ query: "retry tests", include_done: true })).items,
  ).toMatchObject([{ id: "archive", band: null }]);
  expect((await stub.getCanvas({ limit: 1 })).items).toHaveLength(1);
  expect((await stub.getCanvas({ project: "Missing" })).items).toEqual([]);
});

it("defaults to 50 canvas items and caps larger requests at 200 with open items first", async () => {
  const stub = newWorkspace();
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    sql.exec(`
      WITH RECURSIVE numbers(n) AS (
        VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 201
      )
      INSERT INTO items (id, project_id, title) SELECT n, 'inbox', 'Task ' || n FROM numbers
    `);
    sql.exec(`
      UPDATE items SET status = 'done', updated_at = '2099-01-01' WHERE id = '1';
      UPDATE items SET status = 'cancelled', updated_at = '2099-01-01' WHERE id = '2';
    `);
  });
  expect((await stub.getCanvas()).items).toHaveLength(50);
  const { items } = await stub.getCanvas({ limit: 500, include_done: true });
  expect(items).toHaveLength(200);
  expect(items.slice(0, 199).every(({ status }) => status === "queued")).toBe(
    true,
  );
  expect(items[199].status).toBe("done");
});
