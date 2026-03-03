import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import type { ConversationKey } from '../src/gateway/sessionStore.js';

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
    uiJsonMaxChars: 1000,
    contextReplayEnabled: false,
    contextReplayRuns: 0,
    contextReplayMaxChars: 0,
  };
}

test('/help prints command list without requiring binding', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const router = new GatewayRouter({ db, config: createConfig() as any });

  const key: ConversationKey = {
    platform: 'telegram',
    chatId: 'c',
    threadId: null,
    userId: 'u',
  };

  const out: string[] = [];
  await router.handleUserMessage(key, '/help', {
    sendText: async (t: string) => out.push(t),
  } as any);

  const text = out.join('\n');
  assert.ok(text.includes('Commands:'));
  assert.ok(text.includes('/ui'));
  assert.ok(text.includes('/workspace'));

  router.close();
  db.close();
});
