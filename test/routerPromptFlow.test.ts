import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrations.js';
import { GatewayRouter } from '../src/gateway/router.js';
import { BindingRuntime } from '../src/gateway/bindingRuntime.js';
import type { StdioProcess } from '../src/acp/stdio.js';
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../src/acp/jsonrpc.js';
import {
  createRun,
  createSession,
  finishRun,
  upsertBinding,
  type ConversationKey,
} from '../src/gateway/sessionStore.js';

class FakeRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  written: JsonRpcMessage[] = [];

  private sessionId = 'sess-1';

  write(message: JsonRpcMessage): void {
    this.written.push(message);

    if ('method' in message) {
      const req = message as JsonRpcRequest;

      if (req.method === 'initialize') {
        queueMicrotask(() =>
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
            },
          } as JsonRpcResponse),
        );
        return;
      }

      if (req.method === 'session/new') {
        queueMicrotask(() =>
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: this.sessionId },
          } as JsonRpcResponse),
        );
        return;
      }

      if (req.method === 'session/prompt') {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'ok' },
              },
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { stopReason: 'end' },
          } as any);
        });
        return;
      }
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(): void {
    // noop
  }

  kill(): void {
    // noop
  }

  private emit(message: JsonRpcMessage): void {
    this.messageHandlers.forEach((h) => h(message));
  }
}

test('router non-command flow creates run/events/checkpoint and uses context replay', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-router-');
  fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'a', 'utf8');

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
    cwd: workspaceRoot,
    loadSupported: false,
  });

  upsertBinding(db, key, sessionKey);

  // Create one previous run + output for context replay
  createRun(db, { runId: 'rPrev', sessionKey, promptText: 'prev' });
  db.prepare(
    `
    INSERT INTO events(run_id, seq, method, payload_json, created_at)
    VALUES(?, 1, 'session/update', ?, ?)
    `,
  ).run(
    'rPrev',
    JSON.stringify({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'prev answer' },
      },
    }),
    Date.now(),
  );
  finishRun(db, { runId: 'rPrev', stopReason: 'end' });

  const rpc = new FakeRpc();

  const router = new GatewayRouter({
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
      workspaceRoot,
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 10_000,
      contextReplayEnabled: true,
      contextReplayRuns: 5,
      contextReplayMaxChars: 10_000,
    } as any,
    runtimeFactory: (p) =>
      new BindingRuntime({
        ...p,
        acpRpc: rpc,
        workspaceRoot,
      }),
  });

  const state = { text: '', messageId: 'm1' as string | null };
  const sink = {
    sendText: async (t: string) => {
      state.text += t;
    },
    flush: async () => {},
    getDeliveryState: () => state,
  };

  await router.handleUserMessage(key, 'hello', sink as any);

  assert.ok(state.text.includes('ok'));

  const runs = db.prepare('SELECT COUNT(*) as n FROM runs').get() as {
    n: number;
  };
  assert.equal(runs.n, 2);

  const checkpoints = db
    .prepare('SELECT COUNT(*) as n FROM delivery_checkpoints')
    .get() as { n: number };
  assert.equal(checkpoints.n, 1);

  const promptReq = rpc.written.find(
    (m: any) => typeof m?.method === 'string' && m.method === 'session/prompt',
  ) as any;
  assert.ok(promptReq);
  const blocks = promptReq.params.prompt as Array<{ type: string; text: string }>;
  assert.ok(blocks[0].text.includes('Context (previous messages'));

  router.close();
  db.close();
});
