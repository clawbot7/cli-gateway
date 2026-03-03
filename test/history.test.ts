import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { buildReplayContextFromRecentRuns } from '../src/gateway/history.js';

function insertSession(db: Database.Database, sessionKey: string): void {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO sessions(session_key, agent_command, agent_args_json, acp_session_id, load_supported, cwd, created_at, updated_at)
    VALUES(?, ?, ?, NULL, 0, ?, ?, ?)
    `,
  ).run(sessionKey, 'agent', '[]', '/tmp', now, now);
}

function insertRun(db: Database.Database, runId: string, sessionKey: string, prompt: string, startedAt: number): void {
  db.prepare(
    `
    INSERT INTO runs(run_id, session_key, prompt_text, started_at)
    VALUES(?, ?, ?, ?)
    `,
  ).run(runId, sessionKey, prompt, startedAt);
}

function insertChunk(db: Database.Database, runId: string, seq: number, text: string): void {
  db.prepare(
    `
    INSERT INTO events(run_id, seq, method, payload_json, created_at)
    VALUES(?, ?, 'session/update', ?, ?)
    `,
  ).run(
    runId,
    seq,
    JSON.stringify({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    }),
    Date.now(),
  );
}

test('buildReplayContextFromRecentRuns returns chronological context', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const sessionKey = 's1';
  insertSession(db, sessionKey);

  const t1 = Date.now() - 20_000;
  const t2 = Date.now() - 10_000;

  insertRun(db, 'r1', sessionKey, 'first?', t1);
  insertChunk(db, 'r1', 1, 'first answer');

  insertRun(db, 'r2', sessionKey, 'second?', t2);
  insertChunk(db, 'r2', 1, 'second answer');

  const ctx = buildReplayContextFromRecentRuns(db, {
    sessionKey,
    excludeRunId: 'r2',
    maxRuns: 10,
    maxChars: 10_000,
  });

  assert.ok(ctx.includes('User: first?'));
  assert.ok(ctx.includes('Assistant: first answer'));
  assert.ok(!ctx.includes('second answer'));
});

test('buildReplayContextFromRecentRuns uses error/stopReason fallback and ignores malformed events', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const sessionKey = 's1';
  insertSession(db, sessionKey);

  const t1 = Date.now() - 20_000;

  insertRun(db, 'r1', sessionKey, 'x?', t1);

  // malformed JSON event should be ignored
  db.prepare(
    `
    INSERT INTO events(run_id, seq, method, payload_json, created_at)
    VALUES(?, ?, 'session/update', ?, ?)
    `,
  ).run('r1', 1, '{bad json', Date.now());

  // stop_reason fallback
  db.prepare('UPDATE runs SET stop_reason = ? WHERE run_id = ?').run('end', 'r1');

  const ctx = buildReplayContextFromRecentRuns(db, {
    sessionKey,
    excludeRunId: 'none',
    maxRuns: 10,
    maxChars: 10_000,
  });

  assert.ok(ctx.includes('[stop_reason] end'));

  // truncation
  const ctx2 = buildReplayContextFromRecentRuns(db, {
    sessionKey,
    excludeRunId: 'none',
    maxRuns: 10,
    maxChars: 10,
  });
  assert.ok(ctx2.length < ctx.length);
});
