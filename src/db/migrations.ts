import type { Db } from './db.js';

const LATEST_VERSION = 3;

export function migrate(db: Db): void {
  db.exec(
    `
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    INSERT INTO schema_version(version)
    SELECT 0
    WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    `,
  );

  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;

  if (current > LATEST_VERSION) {
    throw new Error(`DB schema version ${current} is newer than app`);
  }

  if (current < 1) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        agent_command TEXT NOT NULL,
        agent_args_json TEXT NOT NULL,
        acp_session_id TEXT,
        load_supported INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bindings (
        binding_key TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_key) REFERENCES sessions(session_key)
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        stop_reason TEXT,
        error TEXT,
        FOREIGN KEY(session_key) REFERENCES sessions(session_key)
      );

      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        method TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, seq),
        FOREIGN KEY(run_id) REFERENCES runs(run_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        binding_key TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(binding_key) REFERENCES bindings(binding_key)
      );

      UPDATE schema_version SET version = 1;
      `,
    );
  }

  if (current < 2) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS tool_policies (
        binding_key TEXT NOT NULL,
        tool_kind TEXT NOT NULL,
        policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(binding_key, tool_kind),
        FOREIGN KEY(binding_key) REFERENCES bindings(binding_key)
      );

      UPDATE schema_version SET version = 2;
      `,
    );
  }

  if (current < 3) {
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS delivery_checkpoints (
        binding_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        message_id TEXT,
        text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(binding_key, run_id),
        FOREIGN KEY(binding_key) REFERENCES bindings(binding_key),
        FOREIGN KEY(run_id) REFERENCES runs(run_id)
      );

      UPDATE schema_version SET version = 3;
      `,
    );
  }
}
