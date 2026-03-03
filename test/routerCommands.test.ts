import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import {
  createRun,
  createSession,
  finishRun,
  upsertBinding,
  type ConversationKey,
} from '../src/gateway/sessionStore.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function createConfig() {
  return {
    discordToken: undefined,
    discordAllowChannelId: undefined,
    telegramToken: undefined,

    feishuAppId: undefined,
    feishuAppSecret: undefined,
    feishuVerificationToken: undefined,
    feishuListenPort: 3030,

    acpAgentCommand: 'node',
    acpAgentArgs: [],

    workspaceRoot: '/tmp/cli-gateway-test',
    dbPath: ':memory:',

    schedulerEnabled: false,

    runtimeIdleTtlSeconds: 999,
    maxBindingRuntimes: 5,

    uiDefaultMode: 'verbose',
    uiJsonMaxChars: 5000,

    contextReplayEnabled: false,
    contextReplayRuns: 0,
    contextReplayMaxChars: 1000,
  };
}

function createSink() {
  const texts: string[] = [];
  return {
    texts,
    sink: {
      sendText: async (t: string) => {
        texts.push(t);
      },
      flush: async () => {},
    },
  };
}

test('/ui sets and shows mode', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

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
  upsertBinding(db, key, 's1');

  const { sink, texts } = createSink();
  await router.handleUserMessage(key, '/ui show', sink as any);
  assert.equal(texts.at(-1), 'UI mode: verbose');

  await router.handleUserMessage(key, '/ui summary', sink as any);
  assert.equal(texts.at(-1), 'OK: UI mode set to summary');

  await router.handleUserMessage(key, '/ui show', sink as any);
  assert.equal(texts.at(-1), 'UI mode: summary');

  router.close();
});

test('/cron add/list/del works', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'telegram',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const { sink, texts } = createSink();

  // list when empty
  await router.handleUserMessage(key, '/cron list', sink as any);
  assert.equal(texts.at(-1), 'No jobs for this conversation.');

  // invalid add usage
  texts.length = 0;
  await router.handleUserMessage(key, '/cron add 0 0 * * *', sink as any);
  assert.ok(String(texts.at(-1)).includes('Usage: /cron add'));

  // missing jobId
  texts.length = 0;
  await router.handleUserMessage(key, '/cron del', sink as any);
  assert.ok(String(texts.at(-1)).includes('Usage: /cron del'));

  // create job
  texts.length = 0;
  await router.handleUserMessage(key, '/cron add 0 0 * * * hello', sink as any);
  assert.ok(String(texts.at(-1)).includes('OK: job created'));

  // unknown subcommand
  texts.length = 0;
  await router.handleUserMessage(key, '/cron wat', sink as any);
  assert.ok(String(texts.at(-1)).includes('Unknown /cron subcommand'));

  // list shows job
  texts.length = 0;
  await router.handleUserMessage(key, '/cron list', sink as any);
  assert.ok(String(texts.join('\n')).includes('template="hello"'));

  const row = db
    .prepare('SELECT job_id as jobId FROM jobs LIMIT 1')
    .get() as { jobId: string };

  // disable / enable
  texts.length = 0;
  await router.handleUserMessage(key, `/cron disable ${row.jobId}`, sink as any);
  assert.equal(texts.at(-1), `OK: job disabled ${row.jobId}`);

  texts.length = 0;
  await router.handleUserMessage(key, `/cron enable ${row.jobId}`, sink as any);
  assert.equal(texts.at(-1), `OK: job enabled ${row.jobId}`);

  // delete
  texts.length = 0;
  await router.handleUserMessage(key, `/cron del ${row.jobId}`, sink as any);
  assert.equal(texts.at(-1), `OK: job deleted ${row.jobId}`);

  router.close();
});

test('/allow and /deny show missing binding when no binding exists', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const { sink, texts } = createSink();

  await router.handleUserMessage(key, '/allow 1', sink as any);
  assert.equal(texts.at(-1), 'No session binding. Send a message first.');

  await router.handleUserMessage(key, '/deny', sink as any);
  assert.equal(texts.at(-1), 'No session binding. Send a message first.');

  router.close();
});

test('handlePermissionUi validates actor and dispatches to runtime', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

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
  upsertBinding(db, key, 's1');

  let called = false;
  (router as any).runtimesBySessionKey.set('s1', {
    runtime: {
      decidePermission: async () => {
        called = true;
        return { ok: true, message: 'OK' };
      },
      close: () => {},
    },
    lastUsedMs: Date.now(),
  });

  const res = await router.handlePermissionUi({
    platform: 'discord',
    sessionKey: 's1',
    requestId: 'x',
    decision: 'allow',
    actorUserId: 'u',
  });

  assert.equal(res.ok, true);
  assert.equal(called, true);

  router.close();
});

test('/last and /replay return stored output and update checkpoint', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

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
  upsertBinding(db, key, 's1');

  const runId = 'r1';
  createRun(db, { runId, sessionKey: 's1', promptText: 'hi' });

  db.prepare(
    `
    INSERT INTO events(run_id, seq, method, payload_json, created_at)
    VALUES(?, ?, 'session/update', ?, ?)
    `,
  ).run(
    runId,
    1,
    JSON.stringify({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello world' },
      },
    }),
    Date.now(),
  );

  db.prepare(
    `
    INSERT INTO events(run_id, seq, method, payload_json, created_at)
    VALUES(?, ?, 'session/update', ?, ?)
    `,
  ).run(
    runId,
    2,
    JSON.stringify({
      update: {
        sessionUpdate: 'tool_call_update',
        title: 'terminal/create',
      },
    }),
    Date.now(),
  );

  db.prepare(
    `
    INSERT INTO events(run_id, seq, method, payload_json, created_at)
    VALUES(?, ?, 'session/update', ?, ?)
    `,
  ).run(
    runId,
    3,
    JSON.stringify({
      update: {
        sessionUpdate: 'plan',
      },
    }),
    Date.now(),
  );

  finishRun(db, { runId, stopReason: 'end' });

  const { sink, texts } = createSink();
  await router.handleUserMessage(key, '/last', sink as any);
  assert.equal(texts.at(-1), 'hello world');

  texts.length = 0;

  const state = { text: '', messageId: 'm1' as string | null };

  await router.handleUserMessage(
    key,
    `/replay ${runId}`,
    {
      ...sink,
      getDeliveryState: () => state,
    } as any,
  );

  const replayed = texts.join('');
  assert.ok(replayed.includes('hello world'));
  assert.ok(replayed.includes('[tool] terminal/create'));
  assert.ok(replayed.includes('[plan]'));

  const cp = db
    .prepare(
      'SELECT COUNT(*) as n FROM delivery_checkpoints WHERE run_id = ? LIMIT 1',
    )
    .get(runId) as { n: number };
  assert.equal(cp.n, 1);

  router.close();
});
