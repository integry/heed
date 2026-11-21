import { INBOX_PROJECT_ID } from "@heedwork/core";

function reconcileWorkspaceColumns(sql: SqlStorage): void {
  const demo = "demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1))";
  for (const [table, column, definition] of [
    ["events", "actor_user", "actor_user TEXT"],
    ["projects", "demo", demo],
    ["items", "demo", demo],
  ]) {
    const hasColumn = sql
      .exec("SELECT 1 FROM pragma_table_info(?) WHERE name = ?", table, column)
      .toArray().length;
    if (!hasColumn) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function ensureHandoffColumns(sql: SqlStorage): void {
  const columns = new Set(
    sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('items')")
      .toArray()
      .map(({ name }) => name),
  );
  for (const [name, definition] of [
    ["handoff_options", "TEXT NOT NULL DEFAULT '[]'"],
    ["handoff_answer", "TEXT"],
    ["handoff_answered_at", "TEXT"],
  ]) {
    if (!columns.has(name))
      sql.exec(`ALTER TABLE items ADD COLUMN ${name} ${definition}`);
  }
}

const migrations = [
  // Version 1
  (sql: SqlStorage) => {
    sql.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
        external_key TEXT UNIQUE,
        title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        depth INTEGER NOT NULL DEFAULT 1 CHECK (depth BETWEEN 1 AND 3),
        priority INTEGER NOT NULL DEFAULT 5,
        scheduled_on TEXT,
        sort_key REAL,
        layout_pos TEXT NOT NULL DEFAULT '{}',
        locked_fields TEXT NOT NULL DEFAULT '[]',
        time_type TEXT NOT NULL DEFAULT 'flexible',
        time_at TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        handoff INTEGER NOT NULL DEFAULT 0,
        handoff_note TEXT,
        reopen_count INTEGER NOT NULL DEFAULT 0,
        reopen_reason TEXT,
        agent_name TEXT,
        created_by TEXT NOT NULL DEFAULT 'human',
        ref_url TEXT,
        note TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        last_heartbeat_at TEXT,
        completed_at TEXT,
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
        scope TEXT NOT NULL DEFAULT 'report',
        default_project_id TEXT REFERENCES projects(id),
        secret_hash TEXT NOT NULL,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        at TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT
      );

      CREATE TABLE push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        keys TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_events_item ON events(item_id, at);
      -- UTC is the read fallback until the first signed-in browser sets a timezone.
      INSERT INTO settings (key, value) VALUES ('guidance', '');
    `);
    sql.exec(
      "INSERT INTO projects (id, name) VALUES (?, 'Inbox')",
      INBOX_PROJECT_ID,
    );
  },
  // Version 2
  (sql: SqlStorage) => {
    sql.exec(
      "CREATE INDEX idx_tokens_hash_prefix ON tokens (substr(secret_hash, 1, 16))",
    );
  },
  // Version 3
  (sql: SqlStorage) => {
    sql.exec("ALTER TABLE items ADD COLUMN completed_band TEXT");
  },
  // Version 4
  (sql: SqlStorage) => {
    sql.exec(`
      CREATE TABLE push_rate_limits (
        token_id TEXT PRIMARY KEY REFERENCES tokens(id) ON DELETE CASCADE,
        attempts TEXT NOT NULL
      );
    `);
  },
  // Version 5
  (sql: SqlStorage) => {
    sql.exec("ALTER TABLE events ADD COLUMN actor_user TEXT");
  },
  // Version 6 reconciles legacy version-5 layouts with demo flags or actor attribution.
  reconcileWorkspaceColumns,
  // Version 7 brings both version-6 layouts to the same schema.
  (sql: SqlStorage) => {
    reconcileWorkspaceColumns(sql);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY,
        registration TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_consents (
        hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        request TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_grants (
        id TEXT PRIMARY KEY REFERENCES tokens(id) ON DELETE CASCADE,
        client_name TEXT NOT NULL,
        authorization TEXT NOT NULL,
        resource TEXT NOT NULL,
        code_hash TEXT UNIQUE,
        code_expires_at INTEGER NOT NULL,
        access_expires_at INTEGER,
        refresh_hash TEXT UNIQUE,
        refresh_expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_used_refresh_tokens (
        hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_used_refresh_grant ON oauth_used_refresh_tokens(grant_id);
    `);
  },
  // Version 8
  (sql: SqlStorage) => {
    sql.exec(
      "ALTER TABLE items ADD COLUMN acceptance TEXT NOT NULL DEFAULT '[]'",
    );
  },
  // Version 9 introduced handoff replies on the target branch.
  ensureHandoffColumns,
  // Version 10 reconciles both version-9 layouts and retires sample data.
  (sql: SqlStorage) => {
    ensureHandoffColumns(sql);
    if (
      !sql
        .exec(
          "SELECT EXISTS(SELECT 1 FROM items WHERE demo = 1) OR EXISTS(SELECT 1 FROM projects WHERE demo = 1) AS present",
        )
        .one().present
    )
      return;
    sql.exec(
      `
        WITH RECURSIVE tree(id, surviving_parent, surviving_depth, next_parent, next_depth) AS (
          SELECT id, NULL, 1, CASE WHEN demo = 0 THEN id END, 1 + (demo = 0)
          FROM items WHERE parent_id IS NULL
          UNION ALL
          SELECT child.id, tree.next_parent, tree.next_depth,
                 CASE WHEN child.demo = 0 THEN child.id ELSE tree.next_parent END,
                 tree.next_depth + (child.demo = 0)
          FROM tree JOIN items AS child ON child.parent_id = tree.id
        )
        UPDATE items SET parent_id = tree.surviving_parent, depth = tree.surviving_depth,
          project_id = CASE WHEN project_id IN (SELECT id FROM projects WHERE demo = 1)
                            THEN ? ELSE project_id END
        FROM tree WHERE items.id = tree.id AND items.demo = 0
          AND (items.parent_id IS NOT tree.surviving_parent
            OR items.depth <> tree.surviving_depth
            OR items.project_id IN (SELECT id FROM projects WHERE demo = 1))
      `,
      INBOX_PROJECT_ID,
    );
    sql.exec("DELETE FROM items WHERE demo = 1");
    sql.exec(
      "UPDATE tokens SET default_project_id = NULL WHERE default_project_id IN (SELECT id FROM projects WHERE demo = 1)",
    );
    sql.exec("DELETE FROM projects WHERE demo = 1");
  },
];

export function migrateWorkspace(storage: DurableObjectStorage): void {
  const { sql } = storage;
  sql.exec("PRAGMA foreign_keys = ON");

  const hasSettings =
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
      )
      .toArray().length > 0;
  const version = hasSettings
    ? Number(
        sql
          .exec<{ value: string }>(
            "SELECT value FROM settings WHERE key = 'schema_version'",
          )
          .toArray()[0]?.value ?? 0,
      )
    : 0;

  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version > migrations.length
  ) {
    throw new Error(`Unsupported workspace schema version: ${version}`);
  }

  for (let index = version; index < migrations.length; index++) {
    storage.transactionSync(() => {
      migrations[index](sql);
      sql.exec(
        `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        String(index + 1),
      );
    });
  }
}
