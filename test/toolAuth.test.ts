import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { ToolAuth } from '../src/gateway/toolAuth.js';
import { createSession, upsertBinding, type ConversationKey } from '../src/gateway/sessionStore.js';

test('ToolAuth consume supports once grants and persistent policy', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const toolAuth = new ToolAuth(db);

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

  assert.equal(toolAuth.consume(sessionKey, 'read'), false);

  toolAuth.grantOnce(sessionKey, 'read', 2);
  assert.equal(toolAuth.consume(sessionKey, 'read'), true);
  assert.equal(toolAuth.consume(sessionKey, 'read'), true);
  assert.equal(toolAuth.consume(sessionKey, 'read'), false);

  toolAuth.setPersistentPolicy(binding.bindingKey, 'execute', 'reject');
  assert.equal(toolAuth.consume(sessionKey, 'execute'), false);

  toolAuth.setPersistentPolicy(binding.bindingKey, 'execute', 'allow');
  assert.equal(toolAuth.consume(sessionKey, 'execute'), true);
});
