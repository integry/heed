import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, onTestFinished, vi } from "vitest";
import type { Actor } from "../shared/item-operations";
import { INBOX_PROJECT_ID, ItemSchema } from "../shared/workspace";
import type { Event, Item } from "../shared/workspace";
import { getWorkspaceStub } from "./workspace";

const human = { kind: "human" } satisfies Actor;
const reporter = {
  kind: "agent",
  scope: "report",
  name: "Builder",
} satisfies Actor;
const steer = {
  kind: "agent",
  scope: "steer",
  name: "Interactive",
} satisfies Actor;
const day = 24 * 60 * 60 * 1000;

function newWorkspace() {
  return getWorkspaceStub(env, crypto.randomUUID());
}

async function events(stub: ReturnType<typeof newWorkspace>, itemId: string) {
  return runInDurableObject(stub, (_, { storage: { sql } }) =>
    sql
      .exec<Event>("SELECT * FROM events WHERE item_id = ? ORDER BY id", itemId)
      .toArray(),
  );
}

const pushEndpoint = "https://push.example.test/subscription";

async function subscribeForTest(stub: ReturnType<typeof newWorkspace>) {
  const keys = {
    p256dh:
      "BFLfBq-L-72mUAuH3nwpAGqQ9De5_ftgxlUkdf45jGf4nFaueFozpviheT9ZOXjpRQSKpem_-p5GIt0XjVw8rJE",
    auth: "dscFXAila4MdiAUf94O-hQ",
  };
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    sql.exec(
      "INSERT INTO push_subscriptions (endpoint, keys) VALUES (?, ?)",
      pushEndpoint,
      JSON.stringify(keys),
    );
  });
}

it("creates items in Inbox, the actor default, the explicit project or the parent's project", async () => {
  const stub = newWorkspace();
  const { id: dev } = await stub.createProject({ name: "Dev" });
  const { id: billing } = await stub.createProject({ name: "Billing" });
  const agent = { ...reporter, default_project_id: dev };

  const {
    items: [inbox],
  } = await stub.addItem(human, { title: "Review" });
  expect(ItemSchema.parse(inbox)).toMatchObject({
    project_id: INBOX_PROJECT_ID,
    depth: 1,
    created_by: "human",
    agent_name: null,
    priority: 5,
    status: "queued",
  });
  expect(inbox.id).toMatch(/^[a-f0-9]{16}$/);

  const {
    items: [goal],
  } = await stub.addItem(agent, { title: "Release" });
  expect(goal).toMatchObject({
    project_id: dev,
    created_by: "agent",
    agent_name: reporter.name,
  });
  const {
    items: [other],
  } = await stub.addItem(agent, {
    title: "Invoices",
    project: billing,
    agent_name: null,
  });
  expect(other).toMatchObject({ project_id: billing, agent_name: null });

  const {
    items: [child],
  } = await stub.addItem(agent, {
    title: "Test invoices",
    parent_id: other.id,
    project: dev,
    agent_name: "Reviewer",
  });
  expect(child).toMatchObject({
    depth: 2,
    project_id: billing,
    parent_id: other.id,
    agent_name: "Reviewer",
  });
  const {
    items: [leaf],
  } = await stub.addItem(agent, { title: "Sample", parent_id: child.id });
  expect(leaf).toMatchObject({
    depth: 3,
    project_id: billing,
    parent_id: child.id,
  });
  expect(await events(stub, goal.id)).toEqual([
    expect.objectContaining({ kind: "created", actor: reporter.name }),
  ]);

  await runInDurableObject(stub, (workspace) => {
    expect(() =>
      workspace.addItem(agent, { title: "Too deep", parent_id: leaf.id }),
    ).toThrow(/depth 3.*attach to the parent/i);
    expect(() =>
      workspace.addItem(agent, {
        title: "Missing project",
        project: "missing",
      }),
    ).toThrow("Project not found");
    expect(() =>
      workspace.addItem(agent, {
        title: "Missing parent",
        parent_id: "missing",
      }),
    ).toThrow("Item not found");
  });
});

it("upserts by external key atomically, preserving omitted fields and creation identity", async () => {
  const stub = newWorkspace();
  const { id: project } = await stub.createProject({ name: "Dev" });
  const input = {
    title: "Implement queue",
    project,
    external_key: "heed#queue",
    tags: ["release"],
    agent_name: "Reviewer",
  };
  const created = await Promise.all([
    stub.addItem(reporter, input),
    stub.addItem(reporter, input),
  ]);
  const id = created[0].item_id;
  expect(created.map((result) => result.item_id)).toEqual([id, id]);
  expect(created.map((result) => result.items.length).sort()).toEqual([0, 1]);

  const {
    items: [updated],
    guidance_updated_at,
  } = await stub.addItem(reporter, {
    title: "Ship queue",
    external_key: input.external_key,
    status: "done",
    note: "Merged",
  });
  expect(guidance_updated_at).toBeNull();
  expect(updated).toMatchObject({
    id,
    title: "Ship queue",
    project_id: project,
    tags: '["release"]',
    created_by: "agent",
    agent_name: "Reviewer",
    status: "done",
    completed_at: expect.any(String),
    note: "Merged",
  });
  expect((await events(stub, id)).map(({ kind }) => kind)).toEqual([
    "created",
    "status",
    "note",
  ]);
  const retry = { title: updated.title, external_key: input.external_key };
  const reassigned = await stub.addItem(reporter, {
    ...retry,
    agent_name: "CI",
  });
  expect(reassigned.items).toEqual([
    expect.objectContaining({ id, agent_name: "CI" }),
  ]);
  const cleared = await stub.addItem(reporter, { ...retry, agent_name: null });
  expect(cleared.items).toEqual([
    expect.objectContaining({ id, agent_name: null }),
  ]);
  expect((await stub.addItem(reporter, retry)).items).toEqual([]);
  await runInDurableObject(stub, (workspace, { storage: { sql } }) => {
    expect(() =>
      workspace.addItem(reporter, { ...input, project: INBOX_PROJECT_ID }),
    ).toThrow("Report scope cannot change project");
    expect(sql.exec("SELECT id FROM items").toArray()).toEqual([{ id }]);
  });
});

it("validates actors, partial fields, dates, selectors and text limits", async () => {
  const stub = newWorkspace();
  const { item_id } = await stub.addItem(human, { title: "🙂".repeat(200) });
  const {
    items: [edited],
  } = await stub.updateItem(human, {
    item_id,
    tags: ["testing"],
    ref_url: "https://example.test",
    time_type: "deadline",
    time_at: "2026-02-28T12:00:00+02:00",
  });
  expect(edited).toMatchObject({
    title: "🙂".repeat(200),
    tags: '["testing"]',
    ref_url: "https://example.test",
    time_type: "deadline",
    time_at: "2026-02-28T12:00:00+02:00",
  });
  expect(
    (await stub.updateItem(human, { item_id, time_at: null, ref_url: null }))
      .items[0],
  ).toMatchObject({ time_at: null, ref_url: null, time_type: "deadline" });
  await stub.reportProgress(reporter, { item_id, note: "🙂".repeat(280) });

  await runInDurableObject(stub, async (workspace) => {
    expect(() => workspace.addItem(human, { title: "x".repeat(201) })).toThrow(
      "at most 200 characters",
    );
    expect(() =>
      workspace.updateItem(human, { item_id, title: "x".repeat(201) }),
    ).toThrow("at most 200 characters");
    expect(() =>
      workspace.addItem(human, { title: "Task", note: "x".repeat(281) }),
    ).toThrow("at most 280 characters");
    expect(() =>
      workspace.reportProgress(reporter, { item_id, note: "x".repeat(281) }),
    ).toThrow("at most 280 characters");
    await expect(
      workspace.flagHandoff(reporter, { item_id, note: "x".repeat(281) }),
    ).rejects.toThrow("at most 280 characters");
    expect(() => workspace.reportProgress(reporter, {})).toThrow("exactly one");
    expect(() =>
      workspace.reportProgress(reporter, { item_id, external_key: "key" }),
    ).toThrow("exactly one");
    expect(() =>
      workspace.updateItem(human, { item_id, priority: 11 }),
    ).toThrow();
    expect(() =>
      workspace.updateItem(human, { item_id, scheduled_on: "2026-02-30" }),
    ).toThrow();
    expect(() =>
      workspace.updateItem(human, { item_id, time_at: "2026-02-28" }),
    ).toThrow();
    expect(() =>
      workspace.addItem({ ...reporter, scope: "admin" } as unknown as Actor, {
        title: "Task",
      }),
    ).toThrow();
  });
});

it("rejects report-only restrictions and ignores locked fields while applying the rest", async () => {
  const stub = newWorkspace();
  const guidance = await stub.setGuidance(steer, "Keep billing first");
  const {
    item_id,
    guidance_updated_at,
    items: [created],
  } = await stub.addItem(steer, {
    title: "Invoice",
    priority: 8,
    scheduled_on: "2026-11-20",
  });
  expect(guidance_updated_at).toBe(guidance.guidance_updated_at);
  expect(created).toMatchObject({
    created_by: "agent",
    agent_name: steer.name,
  });
  expect(JSON.parse(created.locked_fields)).toEqual([
    "priority",
    "scheduled_on",
  ]);

  const locked = await stub.updateItem(human, {
    item_id,
    sort_key: 0,
    hidden: true,
    layout_pos: { radar: { angle: 0.3, radius: 0.6 } },
  });
  expect(locked.items[0]).toMatchObject({
    sort_key: 0,
    hidden: 1,
    layout_pos: '{"radar":{"angle":0.3,"radius":0.6}}',
  });
  expect(JSON.parse(locked.items[0].locked_fields)).toEqual([
    "priority",
    "scheduled_on",
    "sort_key",
    "layout_pos",
  ]);

  const result = await stub.updateItem(reporter, {
    item_id,
    title: "Check invoice",
    priority: 2,
    scheduled_on: null,
  });
  expect(result.items[0]).toMatchObject({
    title: "Check invoice",
    priority: 8,
    scheduled_on: "2026-11-20",
  });
  expect(result.ignored_fields).toEqual(["priority", "scheduled_on"]);
  const upsert = await stub.addItem(human, {
    title: "Other invoice",
    priority: 5,
    external_key: "locked",
  });
  expect(
    await stub.addItem(reporter, {
      external_key: "locked",
      title: "Review other invoice",
      priority: 1,
    }),
  ).toMatchObject({
    item_id: upsert.item_id,
    ignored_fields: ["priority"],
    items: [
      expect.objectContaining({
        title: "Review other invoice",
        priority: 5,
        agent_name: null,
      }),
    ],
  });

  await runInDurableObject(stub, (workspace) => {
    for (const [field, value] of Object.entries({
      project: INBOX_PROJECT_ID,
      hidden: false,
      sort_key: null,
      layout_pos: {},
      unlock: "priority",
    })) {
      expect(() =>
        workspace.updateItem(reporter, {
          item_id,
          [field]: value,
          title: "Rejected",
        }),
      ).toThrow(
        field === "unlock"
          ? "Report scope cannot unlock fields"
          : `Report scope cannot change ${field}`,
      );
    }
    expect(() => workspace.setGuidance(reporter, "Override")).toThrow(
      "Report scope cannot change guidance",
    );
  });
  expect(
    await stub.updateItem(reporter, { item_id, priority: 4 }),
  ).toMatchObject({
    items: [],
    ignored_fields: ["priority"],
  });
  await stub.updateItem(steer, { item_id, unlock: "priority" });
  const unlocked = await stub.updateItem(reporter, { item_id, priority: 4 });
  expect(unlocked.items[0]).toMatchObject({
    title: "Check invoice",
    priority: 4,
  });
  expect(unlocked.ignored_fields).toEqual([]);
});

it("moves subtrees atomically and detects depth overflow, cycles and unauthorized project moves", async () => {
  const stub = newWorkspace();
  const { id: dev } = await stub.createProject({ name: "Dev" });
  const { item_id: goal } = await stub.addItem(human, { title: "Goal" });
  const { item_id: task } = await stub.addItem(reporter, {
    title: "Task",
    parent_id: goal,
  });
  const { item_id: leaf } = await stub.addItem(reporter, {
    title: "Leaf",
    parent_id: task,
  });
  const { item_id: target } = await stub.addItem(human, {
    title: "Target",
    project: dev,
  });

  await runInDurableObject(stub, (workspace) => {
    expect(() =>
      workspace.updateItem(human, { item_id: goal, parent_id: target }),
    ).toThrow(/depth 3.*attach to the parent/i);
    expect(() =>
      workspace.updateItem(human, { item_id: goal, parent_id: leaf }),
    ).toThrow("cycle");
    expect(() =>
      workspace.updateItem(human, { item_id: goal, parent_id: goal }),
    ).toThrow("cycle");
    expect(() =>
      workspace.updateItem(reporter, { item_id: task, parent_id: target }),
    ).toThrow("Report scope cannot change project");
    expect(
      workspace.updateItem(human, {
        item_id: goal,
        parent_id: null,
        project: INBOX_PROJECT_ID,
      }).items,
    ).toEqual([]);
  });

  expect(
    (
      await stub.updateItem(steer, {
        item_id: task,
        parent_id: target,
        scheduled_on: "2026-11-20",
      })
    ).items,
  ).toMatchObject([
    { id: task, parent_id: target, project_id: dev, depth: 2 },
    { id: leaf, parent_id: task, project_id: dev, depth: 3 },
  ]);
  const taskMoves = (await events(stub, task)).filter(
    ({ kind }) => kind === "moved",
  );
  expect(taskMoves).toHaveLength(1);
  expect(JSON.parse(taskMoves[0].detail!)).toEqual({
    scheduled_on: { old: null, new: "2026-11-20" },
    project_id: { old: INBOX_PROJECT_ID, new: dev },
    parent_id: { old: goal, new: target },
  });
  expect((await events(stub, leaf)).map(({ kind }) => kind)).toEqual([
    "created",
    "moved",
  ]);
  expect(
    (await stub.updateItem(reporter, { item_id: task, parent_id: null })).items,
  ).toMatchObject([
    { id: task, project_id: dev, depth: 1, parent_id: null },
    { id: leaf, project_id: dev, depth: 2, parent_id: task },
  ]);
  expect(
    (await stub.updateItem(steer, { item_id: task, project: INBOX_PROJECT_ID }))
      .items,
  ).toMatchObject([
    { id: task, project_id: INBOX_PROJECT_ID, depth: 1 },
    { id: leaf, project_id: INBOX_PROJECT_ID, depth: 2 },
  ]);
});

it("reports progress, schedules active work in the workspace timezone and leaves parents and done items alone", async () => {
  const stub = newWorkspace();
  const now = new Date();
  const offset = now.getUTCHours() < 10 ? -10 : 14;
  await stub.setTimezone(
    offset < 0 ? "Pacific/Honolulu" : "Pacific/Kiritimati",
  );
  const localToday = new Date(now.getTime() + (offset * day) / 24)
    .toISOString()
    .slice(0, 10);
  const { item_id: goal } = await stub.addItem(human, { title: "Goal" });
  const { item_id } = await stub.addItem(human, {
    title: "Task",
    parent_id: goal,
    external_key: "release",
    agent_name: "Reviewer",
  });
  const {
    items: [active],
  } = await stub.reportProgress(reporter, {
    external_key: "release",
    status: "active",
    note: "Building",
  });
  expect(active).toMatchObject({
    status: "active",
    agent_name: "Reviewer",
    scheduled_on: localToday,
    last_heartbeat_at: expect.any(String),
  });
  const done = (
    await stub.reportProgress(reporter, {
      item_id,
      status: "done",
      agent_name: "CI",
    })
  ).items[0];
  expect(done).toMatchObject({
    status: "done",
    completed_at: expect.any(String),
    agent_name: "CI",
    note: "Building",
  });
  expect(
    (
      await stub.reportProgress(reporter, {
        item_id,
        note: "Released",
        ref_url: "https://example.test/pr",
      })
    ).items[0],
  ).toMatchObject({
    status: "done",
    completed_at: done.completed_at,
    agent_name: "CI",
    note: "Released",
    ref_url: "https://example.test/pr",
  });
  const cleared = await stub.reportProgress(reporter, {
    item_id,
    status: "done",
    agent_name: null,
  });
  expect(cleared.items).toEqual([
    expect.objectContaining({ id: item_id, agent_name: null }),
  ]);
  expect(
    (await stub.reportProgress(reporter, { item_id, status: "done" })).items,
  ).toEqual([]);
  const itemEvents = await events(stub, item_id);
  expect(itemEvents.map(({ kind }) => kind)).toEqual([
    "created",
    "status",
    "note",
    "moved",
    "status",
    "note",
  ]);
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    expect(
      sql.exec<Item>("SELECT * FROM items WHERE id = ?", goal).one(),
    ).toMatchObject({ status: "queued", completed_at: null });
  });
  const fixed = await stub.addItem(human, {
    title: "Future work",
    scheduled_on: "2030-01-01",
  });
  expect(
    (
      await stub.reportProgress(reporter, {
        item_id: fixed.item_id,
        status: "active",
      })
    ).items[0].scheduled_on,
  ).toBe("2030-01-01");
  const backlog = await stub.addItem(human, {
    title: "Backlog",
    scheduled_on: null,
  });
  expect(
    await stub.reportProgress(reporter, {
      item_id: backlog.item_id,
      status: "active",
    }),
  ).toMatchObject({
    ignored_fields: ["scheduled_on"],
    items: [expect.objectContaining({ scheduled_on: null, agent_name: null })],
  });
});

it("throttles equivalent heartbeat reports without any SQLite writes", async () => {
  const stub = newWorkspace();
  const { item_id } = await stub.addItem(reporter, {
    title: "Deploy",
    status: "active",
    note: "Running",
  });
  const old = new Date(Date.now() - 6 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await runInDurableObject(stub, (workspace, { storage: { sql } }) => {
    sql.exec(
      "UPDATE items SET last_heartbeat_at = ? WHERE id = ?",
      old,
      item_id,
    );
    const countWrites = () =>
      sql.exec<{ count: number }>("SELECT total_changes() AS count").one()
        .count;
    const before = countWrites();
    const updatedAt = sql
      .exec<Item>("SELECT updated_at FROM items WHERE id = ?", item_id)
      .one().updated_at;
    const input = { item_id, status: "active", note: "Running" } as const;
    const {
      items: [heartbeat],
    } = workspace.reportProgress(reporter, input);
    expect(heartbeat.last_heartbeat_at).not.toBe(old);
    expect(heartbeat.updated_at).toBe(updatedAt);
    expect(countWrites()).toBe(before + 1);
    expect(
      workspace.reportProgress({ ...reporter, name: "Reviewer" }, input).items,
    ).toEqual([]);
    expect(countWrites()).toBe(before + 1);
    expect(
      workspace.reportProgress(reporter, { item_id, note: "Finished build" })
        .items[0].note,
    ).toBe("Finished build");
  });
  expect((await events(stub, item_id)).map(({ kind }) => kind)).toEqual([
    "created",
    "note",
  ]);
});

it("records handoff requests and notification intent and restricts clearing to human and steer", async () => {
  const stub = newWorkspace();
  const { item_id } = await stub.addItem(human, { title: "Rollout" });
  const set = await stub.flagHandoff(reporter, {
    item_id,
    note: "Approve rollout",
    notify: true,
  });
  expect(set.items[0]).toMatchObject({
    handoff: 1,
    handoff_note: "Approve rollout",
    status: "queued",
  });
  expect(
    (await stub.flagHandoff(reporter, { item_id, note: "Approve rollout" }))
      .items,
  ).toEqual([]);
  await runInDurableObject(stub, (workspace) => {
    expect(() => workspace.clearHandoff(reporter, { item_id })).toThrow(
      "Report scope cannot clear a handoff",
    );
  });
  expect((await stub.clearHandoff(steer, { item_id })).items[0]).toMatchObject({
    handoff: 0,
    handoff_note: null,
  });
  expect((await stub.clearHandoff(human, { item_id })).items).toEqual([]);
  const handoffs = (await events(stub, item_id)).filter(
    ({ kind }) => kind === "handoff",
  );
  expect(
    handoffs.map(({ actor, detail }) => ({ actor, ...JSON.parse(detail!) })),
  ).toEqual([
    {
      actor: reporter.name,
      handoff: true,
      note: "Approve rollout",
      notify: true,
    },
    { actor: steer.name, handoff: false, note: null, notify: false },
  ]);
});

it("sends Web Push only when an agent requests notification and records provider acceptance", async () => {
  const stub = newWorkspace();
  const { item_id } = await stub.addItem(human, { title: "Rollout" });
  await subscribeForTest(stub);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 201 }));
  onTestFinished(() => fetchMock.mockRestore());

  await stub.flagHandoff(reporter, { item_id, note: "Review rollout" });
  const note = "Approve rollout";
  await stub.flagHandoff(reporter, { item_id, note, notify: false });
  await stub.flagHandoff(human, { item_id, note, notify: true });
  expect(fetchMock).not.toHaveBeenCalled();

  const result = await stub.flagHandoff(reporter, {
    item_id,
    note,
    notify: true,
  });
  expect(result.items).toEqual([]);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    pushEndpoint,
    expect.objectContaining({
      method: "post",
      headers: expect.objectContaining({
        "content-encoding": "aes128gcm",
        authorization: expect.stringMatching(/^vapid t=/),
      }),
      body: expect.any(Uint8Array),
      redirect: "error",
    }),
  );
  const log = await events(stub, item_id);
  expect(log.filter(({ kind }) => kind === "notified")).toEqual([
    expect.objectContaining({
      actor: reporter.name,
      detail: JSON.stringify({
        title: "Rollout",
        body: note,
        url: `/?item=${item_id}`,
      }),
    }),
  ]);
});

it("keeps the handoff and reports failure when the push service rejects it", async () => {
  const stub = newWorkspace();
  const { item_id } = await stub.addItem(human, { title: "Rollout" });
  await subscribeForTest(stub);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 503 }));
  onTestFinished(() => fetchMock.mockRestore());

  await runInDurableObject(stub, async (workspace) => {
    await expect(
      workspace.flagHandoff(steer, {
        item_id,
        note: "Approve rollout",
        notify: true,
      }),
    ).rejects.toThrow("Handoff recorded, but Web Push failed");
  });
  const log = await events(stub, item_id);
  expect(log.map(({ kind }) => kind)).toEqual(["created", "handoff"]);
  expect(JSON.parse(log[1].detail!)).toMatchObject({
    handoff: true,
    notify: true,
  });
});

it.each(["clear handoff", "remove subscription"] as const)(
  "skips a push if a concurrent mutation can %s during preparation",
  async (change) => {
    const stub = newWorkspace();
    const { item_id } = await stub.addItem(human, { title: "Rollout" });
    await subscribeForTest(stub);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 201 }));
    onTestFinished(() => fetchMock.mockRestore());
    await runInDurableObject(stub, async (workspace, { storage: { sql } }) => {
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      const signMock = vi
        .spyOn(crypto.subtle, "sign")
        .mockImplementationOnce(async (...args) => {
          if (change === "clear handoff") {
            workspace.clearHandoff(steer, { item_id });
          } else {
            sql.exec(
              "DELETE FROM push_subscriptions WHERE endpoint = ?",
              pushEndpoint,
            );
          }
          return sign(...args);
        });
      try {
        await workspace.flagHandoff(reporter, {
          item_id,
          note: "Approve rollout",
          notify: true,
        });
        expect(signMock).toHaveBeenCalled();
      } finally {
        signMock.mockRestore();
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await events(stub, item_id)).map(({ kind }) => kind)).not.toContain(
      "notified",
    );
  },
);

it("handles item deletion after the push request starts", async () => {
  const stub = newWorkspace();
  const { item_id } = await stub.addItem(human, { title: "Rollout" });
  await subscribeForTest(stub);
  await runInDurableObject(stub, async (workspace, { storage: { sql } }) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        expect(
          sql
            .exec(
              "SELECT kind FROM events WHERE item_id = ? ORDER BY id",
              item_id,
            )
            .toArray(),
        ).toEqual([{ kind: "created" }, { kind: "handoff" }]);
        workspace.deleteItem(human, { item_id });
        return new Response(null, { status: 201 });
      });
    try {
      await workspace.flagHandoff(reporter, {
        item_id,
        note: "Approve rollout",
        notify: true,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });
  expect(await events(stub, item_id)).toEqual([]);
});

it("reopens old history, records the reason and increments the count across cancellations", async () => {
  const stub = newWorkspace();
  const { item_id } = await stub.addItem(reporter, {
    title: "Regression",
    external_key: "old",
    status: "done",
  });
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    sql.exec(
      "UPDATE items SET completed_at = '2000-01-01 00:00:00' WHERE id = ?",
      item_id,
    );
  });
  const reopened = (
    await stub.reopenItem(reporter, {
      external_key: "old",
      reason: "Regression found",
    })
  ).items[0];
  expect(reopened).toMatchObject({
    id: item_id,
    status: "queued",
    completed_at: null,
    reopen_count: 1,
    reopen_reason: "Regression found",
    scheduled_on: new Date().toISOString().slice(0, 10),
  });
  const cancelled = (
    await stub.reportProgress(reporter, { item_id, status: "cancelled" })
  ).items[0];
  expect(cancelled).toMatchObject({ status: "cancelled", completed_at: null });
  expect(
    (await stub.reopenItem(human, { item_id, reason: "Resume" })).items[0]
      .reopen_count,
  ).toBe(2);
  const log = await events(stub, item_id);
  expect(log.map(({ kind }) => kind)).toEqual([
    "created",
    "status",
    "reopened",
    "moved",
    "status",
    "status",
    "reopened",
  ]);
  expect(JSON.parse(log[2].detail!)).toEqual({ reason: "Regression found" });
});

it("hard-deletes only for a human and returns all removed items after cascading", async () => {
  const stub = newWorkspace();
  const { item_id: parent } = await stub.addItem(human, { title: "Goal" });
  const { item_id: child } = await stub.addItem(human, {
    title: "Task",
    parent_id: parent,
  });
  const { item_id: other } = await stub.addItem(human, { title: "Other task" });
  await runInDurableObject(stub, (workspace, { storage: { sql } }) => {
    sql.exec(
      "INSERT INTO dependencies (item_id, blocked_by_id) VALUES (?, ?)",
      other,
      child,
    );
    expect(() => workspace.deleteItem(steer, { item_id: parent })).toThrow(
      "Only a human",
    );
    expect(() => workspace.deleteItem(reporter, { item_id: parent })).toThrow(
      "Only a human",
    );
  });
  expect(
    (await stub.deleteItem(human, { item_id: parent })).items.map(
      ({ id }) => id,
    ),
  ).toEqual([parent, child]);
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    expect(sql.exec("SELECT id FROM items").toArray()).toEqual([{ id: other }]);
    expect(sql.exec("SELECT * FROM dependencies").toArray()).toEqual([]);
  });
  expect(await events(stub, parent)).toEqual([]);
  expect(await events(stub, child)).toEqual([]);
  expect(await events(stub, other)).toHaveLength(1);
});

it("prunes old events on an ordinary write at most once a day across evictions", async () => {
  const stub = newWorkspace();
  const { item_id } = await stub.addItem(reporter, {
    title: "Deploy",
    status: "active",
  });
  const old = new Date(Date.now() - 91 * day)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const recent = new Date(Date.now() - 89 * day).toISOString();
  await runInDurableObject(stub, (workspace, { storage: { sql } }) => {
    sql.exec(
      "INSERT INTO events (item_id, at, actor, kind) VALUES (?, ?, 'human', 'note'), (?, ?, 'human', 'note')",
      item_id,
      old,
      item_id,
      recent,
    );
    workspace.updateItem(human, { item_id, title: "Updated today" });
    expect(
      sql.exec("SELECT at FROM events WHERE at = ?", old).toArray(),
    ).toHaveLength(1);
    sql.exec(
      "UPDATE settings SET value = ? WHERE key = 'events_pruned_at'",
      new Date(Date.now() - (25 * day) / 24).toISOString(),
    );
  });
  await evictDurableObject(stub);
  await stub.reportProgress(reporter, { item_id });
  expect((await events(stub, item_id)).some(({ at }) => at === old)).toBe(true);
  await stub.reportProgress(reporter, { item_id, note: "Done building" });
  const remaining = await events(stub, item_id);
  expect(remaining.some(({ at }) => at === old)).toBe(false);
  expect(remaining.some(({ at }) => at === recent)).toBe(true);
});

it("supports idempotent dependency changes and rejects direct and transitive cycles", async () => {
  const stub = newWorkspace();
  const { item_id: first } = await stub.addItem(reporter, { title: "First" });
  const { item_id: second } = await stub.addItem(reporter, { title: "Second" });
  const { item_id: third } = await stub.addItem(reporter, { title: "Third" });
  const edge = {
    item_id: first,
    blocked_by_id: second,
    action: "add",
  } as const;
  expect((await stub.setDependency(reporter, edge)).dependency).toEqual(edge);
  expect((await stub.setDependency(reporter, edge)).dependency).toBeNull();
  await stub.setDependency(reporter, {
    item_id: second,
    blocked_by_id: third,
    action: "add",
  });
  await runInDurableObject(stub, (workspace) => {
    expect(() =>
      workspace.setDependency(reporter, { ...edge, blocked_by_id: first }),
    ).toThrow("cannot depend on itself");
    expect(() =>
      workspace.setDependency(reporter, {
        ...edge,
        item_id: third,
        blocked_by_id: first,
      }),
    ).toThrow("would create a cycle");
    expect(() =>
      workspace.setDependency(reporter, { ...edge, blocked_by_id: "missing" }),
    ).toThrow("Item not found");
  });
  const remove = { ...edge, action: "remove" } as const;
  expect((await stub.setDependency(reporter, remove)).dependency).toEqual(
    remove,
  );
  expect((await stub.setDependency(reporter, remove)).dependency).toBeNull();
  expect(
    (
      await stub.setDependency(reporter, {
        ...edge,
        item_id: third,
        blocked_by_id: first,
      })
    ).dependency,
  ).not.toBeNull();
  expect((await events(stub, first)).map(({ kind }) => kind)).toEqual([
    "created",
  ]);
});
