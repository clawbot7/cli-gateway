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

  private sessionId = 'sess-1';
  private promptId: number | null = null;
  private terminalId: string | null = null;

  constructor(private readonly workspaceRoot: string) {}

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
            id: 2000,
            method: 'fs/write_text_file',
            params: {
              sessionId: this.sessionId,
              path: path.join(this.workspaceRoot, 'out.txt'),
              content: 'x',
            },
          } as any);

          this.emit({
            jsonrpc: '2.0',
            id: 2001,
            method: 'terminal/create',
            params: {
              sessionId: this.sessionId,
              command: 'node',
              args: ['-e', "console.log('hi')"],
              cwd: this.workspaceRoot,
            },
          } as any);
        });

        return;
      }

      return;
    }

    if ('id' in message && 'result' in message) {
      const res = message as JsonRpcResponse;

      if (typeof res.id === 'number' && res.id === 2001) {
        const tid = (res as any).result?.terminalId as string;
        this.terminalId = tid;
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: 2002,
            method: 'terminal/wait_for_exit',
            params: { sessionId: this.sessionId, terminalId: tid },
          } as any);
        });
      }

      if (typeof res.id === 'number' && res.id === 2002) {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            id: 2003,
            method: 'terminal/output',
            params: { sessionId: this.sessionId, terminalId: this.terminalId },
          } as any);
        });
      }

      if (typeof res.id === 'number' && res.id === 2003) {
        queueMicrotask(() => {
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'done' },
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

test('AcpClient handles write_text_file and terminal tools (via BindingRuntime)', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const workspaceRoot = fs.mkdtempSync('/tmp/cli-gateway-terminal-');

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
  toolAuth.setPersistentPolicy(bindingKey, 'edit', 'allow');
  toolAuth.setPersistentPolicy(bindingKey, 'execute', 'allow');

  const rpc = new FakeRpc(workspaceRoot);

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
      uiDefaultMode: 'verbose',
      uiJsonMaxChars: 10_000,
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

  const chunks: string[] = [];
  const sink: OutboundSink = {
    sendText: async (t) => chunks.push(t),
  };

  const res = await rt.prompt({
    runId: 'r1',
    promptText: 'go',
    sink,
    uiMode: 'verbose',
  });

  assert.equal(res.stopReason, 'end');
  assert.ok(chunks.join('').includes('done'));

  const writtenFile = fs.readFileSync(path.join(workspaceRoot, 'out.txt'), 'utf8');
  assert.equal(writtenFile, 'x');

  rt.close();
  db.close();
});
