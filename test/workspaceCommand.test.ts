import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import {
  createSession,
  getSession,
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
    workspaceRoot: os.homedir(),
    dbPath: ':memory:',
    schedulerEnabled: false,
    runtimeIdleTtlSeconds: 999,
    maxBindingRuntimes: 5,
    uiDefaultMode: 'verbose',
    uiJsonMaxChars: 1000,
    contextReplayEnabled: false,
    contextReplayRuns: 0,
    contextReplayMaxChars: 0,
  };
}

test('/workspace show and set updates session cwd and closes runtime', async () => {
  const db = createDb();

  const closed: string[] = [];

  const router = new GatewayRouter({
    db,
    config: createConfig() as any,
    runtimeFactory: ({ workspaceRoot }) =>
      ({
        hasSessionId: () => true,
        prompt: async () => ({ stopReason: 'end', lastSeq: 0 }),
        close: () => closed.push(workspaceRoot),
      }) as any,
  });

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
    cwd: os.homedir(),
    loadSupported: false,
  });
  upsertBinding(db, key, 's1');

  // Create and cache a runtime.
  (router as any).getOrCreateRuntime({ sessionKey: 's1', bindingKey: 'discord:c:-:u' });

  const texts: string[] = [];
  const sink = { sendText: async (t: string) => texts.push(t) };

  await router.handleUserMessage(key, '/workspace show', sink as any);
  assert.ok(String(texts.at(-1)).includes('Workspace:'));

  const next = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-gateway-ws-'));

  texts.length = 0;
  await router.handleUserMessage(key, `/workspace ${next}`, sink as any);
  assert.equal(texts.at(-1), `OK: workspace set to ${next}`);

  const sess = getSession(db, 's1');
  assert.equal(sess?.cwd, next);

  assert.equal(closed.length, 1);

  router.close();
});

test('/workspace rejects invalid paths without crashing', async () => {
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
    cwd: os.homedir(),
    loadSupported: false,
  });
  upsertBinding(db, key, 's1');

  const texts: string[] = [];
  const sink = { sendText: async (t: string) => texts.push(t) };

  await router.handleUserMessage(key, '/ws relative-path', sink as any);
  assert.ok(String(texts.at(-1)).includes('Error:'));

  router.close();
});
