import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { getUiMode, setUiMode } from '../src/db/uiPrefStore.js';

test('ui prefs persist per binding', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const bindingKey = 'discord:chat:-:user';

  // ui_prefs has FK to bindings; create a minimal binding row.
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO sessions(session_key, agent_command, agent_args_json, acp_session_id, load_supported, cwd, created_at, updated_at)
    VALUES(?, ?, ?, NULL, 0, ?, ?, ?)
    `,
  ).run('s1', 'agent', '[]', '/tmp', now, now);

  db.prepare(
    `
    INSERT INTO bindings(binding_key, platform, chat_id, thread_id, user_id, session_key, created_at, updated_at)
    VALUES(?, 'discord', 'chat', NULL, 'user', 's1', ?, ?)
    `,
  ).run(bindingKey, now, now);

  assert.equal(getUiMode(db, bindingKey), null);

  setUiMode(db, bindingKey, 'summary');
  assert.equal(getUiMode(db, bindingKey), 'summary');

  setUiMode(db, bindingKey, 'verbose');
  assert.equal(getUiMode(db, bindingKey), 'verbose');
});
