import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { ToolAuth } from '../src/gateway/toolAuth.js';
import { BindingRuntime } from '../src/gateway/bindingRuntime.js';
import {
  createRun,
  createSession,
  upsertBinding,
  type ConversationKey,
} from '../src/gateway/sessionStore.js';
import type { OutboundSink } from '../src/gateway/types.js';
import type { StdioProcess } from '../src/acp/stdio.js';
import type { JsonRpcMessage, JsonRpcRequest } from '../src/acp/jsonrpc.js';

class NoopRpc implements StdioProcess {
  private handlers: Array<(m: JsonRpcMessage) => void> = [];
  written: JsonRpcMessage[] = [];

  write(message: JsonRpcMessage): void {
    this.written.push(message);
  }
  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.handlers.push(cb);
  }
  onStderr(): void {}
  kill(): void {}
}

class PermReqRpc implements StdioProcess {
  private handlers: Array<(m: JsonRpcMessage) => void> = [];
  written: JsonRpcMessage[] = [];

  write(message: JsonRpcMessage): void {
    this.written.push(message);

    if ('method' in message) {
      const req = message as JsonRpcRequest;
      if (req.method === 'initialize') {
        queueMicrotask(() =>
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { protocolVersion: 1, agentCapabilities: {} },
          } as any),
        );
      }
      if (req.method === 'session/new') {
        queueMicrotask(() =>
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: 'sess' },
          } as any),
        );
      }
      if (req.method === 'session/prompt') {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: 999,
            method: 'session/request_permission',
            params: {
              sessionId: 'sess',
              toolCall: { title: 'terminal/create', kind: 'execute' },
              options: [
                { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
              ],
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { stopReason: 'end' },
          } as any);
        });
      }
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.handlers.push(cb);
  }

  onStderr(): void {}
  kill(): void {}

  private emit(message: JsonRpcMessage): void {
    this.handlers.forEach((h) => h(message));
  }
}

test('denyPermission returns denied message', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

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

  const toolAuth = new ToolAuth(db);
  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's1',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  (rt as any).pendingPermission = {
    requestId: 1,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [
        { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
      ],
    },
  };

  const texts: string[] = [];
  await rt.denyPermission({ sendText: async (t) => texts.push(t) } as any);
  assert.ok(texts.at(-1)?.includes('denied'));

  rt.close();
});

test('decidePermission rejects expired requestId', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

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

  const toolAuth = new ToolAuth(db);
  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's1',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  (rt as any).pendingPermission = {
    requestId: 2,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [{ optionId: 'r1', name: 'Reject once', kind: 'reject_once' }],
    },
  };

  const expired = await rt.decidePermission({ decision: 'deny', requestId: '999' });
  assert.equal(expired.ok, false);
  assert.ok(expired.message.includes('expired'));

  rt.close();
});

test('decidePermission persists allow_always policy', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

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

  const toolAuth = new ToolAuth(db);
  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's1',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  (rt as any).pendingPermission = {
    requestId: 5,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [{ optionId: 'a', name: 'Allow always', kind: 'allow_always' }],
    },
  };

  const allowed = await rt.decidePermission({ decision: 'allow', requestId: '5' });
  assert.equal(allowed.ok, true);
  assert.equal(toolAuth.consume('s1', 'execute'), true);

  rt.close();
});

test('decidePermission persists reject_always and can cancel if no option exists', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

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

  const toolAuth = new ToolAuth(db);
  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey: 's1',
    bindingKey,
    acpRpc: new NoopRpc(),
    workspaceRoot: '/tmp',
  });

  // reject_always branch
  (rt as any).pendingPermission = {
    requestId: 2,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [
        { optionId: 'r2', name: 'Reject always', kind: 'reject_always' },
      ],
    },
  };

  const denied = await rt.decidePermission({ decision: 'deny', requestId: '2' });
  assert.equal(denied.ok, true);
  assert.equal(toolAuth.consume('s1', 'execute'), false);

  // cancelled branch: allow requested but no allow option exists
  (rt as any).pendingPermission = {
    requestId: 3,
    params: {
      sessionId: 'sess',
      toolCall: { kind: 'execute', title: 'terminal/create' },
      options: [{ optionId: 'r1', name: 'Reject once', kind: 'reject_once' }],
    },
  };

  const cancelled = await rt.decidePermission({ decision: 'allow', requestId: '3' });
  assert.equal(cancelled.ok, true);
  assert.ok(cancelled.message.includes('cancelled'));

  rt.close();
});

test('permission fallback text is used when sink has no interactive UI', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

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
  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  createRun(db, { runId: 'r1', sessionKey, promptText: 'go' });

  const toolAuth = new ToolAuth(db);

  const rt = new BindingRuntime({
    db,
    config: {
      discordToken: undefined,
      discordAllowChannelId: undefined,
      telegramToken: undefined,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      feishuVerificationToken: undefined,
      feishuListenPort: 3030,
      acpAgentCommand: 'node',
      acpAgentArgs: [],
      workspaceRoot: '/tmp',
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: new PermReqRpc(),
    workspaceRoot: '/tmp',
  });

  const texts: string[] = [];
  const sink: OutboundSink = {
    sendText: async (t) => texts.push(t),
  };

  const res = await rt.prompt({
    runId: 'r1',
    promptText: 'go',
    sink,
    uiMode: 'summary',
  });

  assert.equal(res.stopReason, 'end');
  assert.ok(texts.join('\n').includes('[permission required]'));

  rt.close();
});
