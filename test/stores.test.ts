import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import {
  createJob,
  deleteJob,
  listJobsForBinding,
  setJobEnabled,
} from '../src/db/jobStore.js';
import {
  getDeliveryCheckpoint,
  upsertDeliveryCheckpoint,
} from '../src/db/deliveryCheckpointStore.js';
import {
  bindingKeyFromConversationKey,
  createRun,
  createSession,
  deleteBinding,
  finishRun,
  getBinding,
  getSession,
  updateSessionCwd,
  upsertBinding,
  type ConversationKey,
} from '../src/gateway/sessionStore.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

test('jobStore create/list/enable/delete', () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  createSession(db, {
    sessionKey: 's1',
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });

  const bindingKey = upsertBinding(db, key, 's1').bindingKey;

  const jobId = createJob(db, {
    bindingKey,
    cronExpr: '0 0 * * *',
    promptTemplate: 'hello',
  });

  const rows = listJobsForBinding(db, bindingKey);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, jobId);

  setJobEnabled(db, jobId, false);
  const rows2 = listJobsForBinding(db, bindingKey);
  assert.equal(rows2[0].enabled, 0);

  deleteJob(db, jobId);
  assert.equal(listJobsForBinding(db, bindingKey).length, 0);
});

test('deliveryCheckpointStore upsert/get', () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const sessionKey = 's1';
  createSession(db, {
    sessionKey,
    agentCommand: 'agent',
    agentArgs: [],
    cwd: '/tmp',
    loadSupported: false,
  });

  const binding = upsertBinding(db, key, sessionKey);

  const runId = 'r1';
  createRun(db, { runId, sessionKey, promptText: 'hi' });
  finishRun(db, { runId, stopReason: 'end' });

  assert.equal(
    getDeliveryCheckpoint(db, { bindingKey: binding.bindingKey, runId }),
    null,
  );

  upsertDeliveryCheckpoint(db, {
    bindingKey: binding.bindingKey,
    runId,
    lastSeq: 12,
    messageId: 'm1',
    text: 'abc',
  });

  const row = getDeliveryCheckpoint(db, { bindingKey: binding.bindingKey, runId });
  assert.ok(row);
  assert.equal(row.lastSeq, 12);
  assert.equal(row.messageId, 'm1');
  assert.equal(row.text, 'abc');

  // Cleanup checkpoint before deleting binding (FK).
  db.prepare('DELETE FROM delivery_checkpoints WHERE run_id = ?').run(runId);

  updateSessionCwd(db, sessionKey, '/tmp/changed');
  assert.equal(getSession(db, sessionKey)?.cwd, '/tmp/changed');

  deleteBinding(db, key);
  assert.equal(getBinding(db, key), null);

  // binding key format stable
  assert.equal(bindingKeyFromConversationKey(key), 'discord:c:-:u');
});
