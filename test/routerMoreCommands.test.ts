import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import type { ConversationKey } from '../src/gateway/sessionStore.js';

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
    runtimeIdleTtlSeconds: 1,
    maxBindingRuntimes: 1,
    uiDefaultMode: 'verbose',
    uiJsonMaxChars: 1000,
    contextReplayEnabled: false,
    contextReplayRuns: 0,
    contextReplayMaxChars: 0,
  };
}

function createSink() {
  const texts: string[] = [];
  return {
    texts,
    sink: {
      sendText: async (t: string) => texts.push(t),
      flush: async () => {},
    },
  };
}

test('command usage errors are reported', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const { sink, texts } = createSink();

  await router.handleUserMessage(key, '/ui', sink as any);
  assert.equal(texts.at(-1), 'No session binding. Send a message first.');

  await router.handleUserMessage(key, '/cron', sink as any);
  assert.ok(String(texts.at(-1)).includes('Usage:'));

  await router.handleUserMessage(key, '/allow', sink as any);
  assert.ok(String(texts.at(-1)).includes('Usage:'));

  router.close();
});

test('/new clears binding and closes runtime', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  // Seed a binding/session via /cron add.
  const { sink, texts } = createSink();
  await router.handleUserMessage(key, '/cron add 0 0 * * * hi', sink as any);

  // Inject a fake runtime.
  const binding = db
    .prepare(
      'SELECT session_key as sessionKey FROM bindings WHERE platform = ? LIMIT 1',
    )
    .get('discord') as { sessionKey: string };

  let closed = false;
  (router as any).runtimesBySessionKey.set(binding.sessionKey, {
    runtime: { close: () => (closed = true) },
    lastUsedMs: Date.now(),
  });

  texts.length = 0;
  await router.handleUserMessage(key, '/new', sink as any);
  assert.ok(String(texts.at(-1)).includes('OK: binding cleared'));
  assert.equal(closed, true);

  router.close();
});

test('sink flush errors are swallowed', async () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: () =>
      ({
        hasSessionId: () => true,
        prompt: async () => ({ stopReason: 'end', lastSeq: 0 }),
        close: () => {},
      }) as any,
  });

  const texts: string[] = [];
  await router.handleUserMessage(
    key,
    'hi',
    {
      sendText: async (t: string) => texts.push(t),
      flush: async () => {
        throw new Error('flush failed');
      },
    } as any,
  );

  // No throw; run still recorded.
  const row = db
    .prepare('SELECT stop_reason as stopReason FROM runs ORDER BY started_at DESC LIMIT 1')
    .get() as { stopReason: string | null };
  assert.equal(row.stopReason, 'end');

  router.close();
});

test('/allow and /deny dispatch to runtime methods', async () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  // Create a binding/session row.
  const router1 = new GatewayRouter({ db, config: createConfig() as any });
  await router1.handleUserMessage(key, '/cron add 0 0 * * * hi', { sendText: async () => {} } as any);
  router1.close();

  const binding = db
    .prepare('SELECT session_key as sessionKey FROM bindings LIMIT 1')
    .get() as { sessionKey: string };

  let allowCalled = false;
  let denyCalled = false;

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: () =>
      ({
        hasSessionId: () => true,
        selectPermissionOption: async () => {
          allowCalled = true;
        },
        denyPermission: async () => {
          denyCalled = true;
        },
        close: () => {},
      }) as any,
  });

  // Ensure runtime exists for this session key.
  (router as any).getOrCreateRuntime({
    sessionKey: binding.sessionKey,
    bindingKey: 'discord:c:-:u',
  });

  const { sink } = createSink();
  await router.handleUserMessage(key, '/allow 1', sink as any);
  await router.handleUserMessage(key, '/deny', sink as any);

  assert.equal(allowCalled, true);
  assert.equal(denyCalled, true);

  router.close();
});

test('unknown command falls through to runtime prompt', async () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  let prompted = false;

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: () =>
      ({
        hasSessionId: () => true,
        prompt: async () => {
          prompted = true;
          return { stopReason: 'end', lastSeq: 0 };
        },
        close: () => {},
      }) as any,
  });

  await router.handleUserMessage(key, '/foo', { sendText: async () => {} } as any);
  assert.equal(prompted, true);

  router.close();
});

test('router error path reports and records run error', async () => {
  const db = createDb();

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: (_p) => {
      return {
        hasSessionId: () => false,
        prompt: async () => {
          throw new Error('boom');
        },
        close: () => {},
      } as any;
    },
  });

  const { sink, texts } = createSink();
  await router.handleUserMessage(key, 'hi', sink as any);

  assert.ok(String(texts.join('\n')).includes('Error: boom'));

  const row = db
    .prepare('SELECT error FROM runs ORDER BY started_at DESC LIMIT 1')
    .get() as { error: string | null };
  assert.ok(String(row.error).includes('boom'));

  router.close();
});

test('/cron enable usage requires jobId', async () => {
  const db = createDb();
  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'discord',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const { sink, texts } = createSink();
  await router.handleUserMessage(key, '/cron enable', sink as any);
  assert.ok(String(texts.at(-1)).includes('Usage: /cron enable'));

  router.close();
});
