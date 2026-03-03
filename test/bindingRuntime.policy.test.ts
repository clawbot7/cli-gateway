import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../src/acp/jsonrpc.js';

class FakeRpc implements StdioProcess {
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  written: JsonRpcMessage[] = [];

  private promptId: number | null = null;
  private sessionId = 'sess-1';
  private workspaceFile: string;

  constructor(params: { workspaceFile: string }) {
    this.workspaceFile = params.workspaceFile;
  }

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
        return;
      }

      if (req.method === 'session/new') {
        queueMicrotask(() =>
          this.emit({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: this.sessionId },
          } as any),
        );
        return;
      }

      if (req.method === 'session/prompt') {
        this.promptId = Number(req.id);

        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: 999,
            method: 'session/request_permission',
            params: {
              sessionId: this.sessionId,
              toolCall: { title: 'fs/read_text_file', kind: 'read' },
              options: [
                { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
              ],
            },
          } as any);
        });

        return;
      }

      return;
    }

    if ('id' in message && 'result' in message) {
      const res = message as JsonRpcResponse;

      if (typeof res.id === 'number' && res.id === 999) {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: 1000,
            method: 'fs/read_text_file',
            params: {
              sessionId: this.sessionId,
              path: this.workspaceFile,
            },
          } as any);
        });
        return;
      }

      if (typeof res.id === 'number' && res.id === 1000) {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'task',
                status: 'running',
              },
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            id: this.promptId!,
            result: { stopReason: 'end' },
          } as any);
        });
      }
    }
  }

  onMessage(cb: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onStderr(): void {}
  kill(): void {}

  private emit(message: JsonRpcMessage): void {
    this.messageHandlers.forEach((h) => h(message));
  }
}

test('BindingRuntime auto-allow policy bypasses interactive UI', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-policy-');
  const filePath = path.join(workspaceRoot, 'hello.txt');
  fs.writeFileSync(filePath, 'hello', 'utf8');

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

  const bindingKey = upsertBinding(db, key, sessionKey).bindingKey;
  createRun(db, { runId: 'r1', sessionKey, promptText: 'go' });

  const toolAuth = new ToolAuth(db);
  toolAuth.setPersistentPolicy(bindingKey, 'read', 'allow');

  const rpc = new FakeRpc({ workspaceFile: filePath });

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
      workspaceRoot,
      dbPath: ':memory:',
      schedulerEnabled: false,
      runtimeIdleTtlSeconds: 999,
      maxBindingRuntimes: 5,
      uiDefaultMode: 'summary',
      uiJsonMaxChars: 1000,
      contextReplayEnabled: false,
      contextReplayRuns: 0,
      contextReplayMaxChars: 0,
    } as any,
    toolAuth,
    sessionKey,
    bindingKey,
    acpRpc: rpc,
    workspaceRoot,
  });

  const texts: string[] = [];
  const ui: any[] = [];
  const sink: OutboundSink = {
    sendText: async (t) => texts.push(t),
    sendUi: async (e) => ui.push(e),
    requestPermission: async () => {
      throw new Error('should not ask');
    },
  };

  const res = await rt.prompt({
    runId: 'r1',
    promptText: 'go',
    sink,
    uiMode: 'summary',
  });

  assert.equal(res.stopReason, 'end');
  assert.ok(texts.some((t) => t.includes('auto-allowed')));
  assert.ok(ui.some((e) => e.kind === 'task'));

  rt.close();
  db.close();
});
