import { INBOX_PROJECT_ID } from "@heedwork/core";

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
