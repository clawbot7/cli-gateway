import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';

test('migrate creates schema at latest version', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  migrate(db);

  const version = db
    .prepare('SELECT version FROM schema_version')
    .get() as { version: number };

  assert.equal(version.version, 4);

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC",
    )
    .all() as Array<{ name: string }>;

  const names = tables.map((t) => t.name);

  for (const expected of [
    'bindings',
    'delivery_checkpoints',
    'events',
    'jobs',
    'runs',
    'schema_version',
    'sessions',
    'tool_policies',
    'ui_prefs',
  ]) {
    assert.ok(names.includes(expected), `missing table: ${expected}`);
  }
});
