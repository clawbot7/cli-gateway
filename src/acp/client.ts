import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { log } from '../logging.js';
import type { Db } from '../db/db.js';
import type { ToolAuth, ToolKind } from '../gateway/toolAuth.js';
import { resolveWorkspacePath } from '../tools/workspace.js';
import {
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc.js';
import { spawnAcpAgent, type StdioProcess } from './stdio.js';
import type {
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  NewSessionResult,
  PromptParams,
  PromptResult,
  RequestPermissionParams,
  RequestPermissionResult,
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalKillParams,
  TerminalOutputParams,
  TerminalOutputResult,
  TerminalReleaseParams,
  TerminalWaitForExitParams,
} from './types.js';

export type AcpRun = {
  runId: string;
  sessionKey: string;
  createdAtMs: number;
};

export type PermissionRequest = {
  requestId: JsonRpcId;
  sessionKey: string;
  sessionId: string;
  params: RequestPermissionParams;
  createdAtMs: number;
};

export type PermissionDecision =
  | { kind: 'selected'; optionId: string }
  | { kind: 'cancelled' };

export type ClientToolEvent = {
  phase: 'start' | 'end' | 'error';
  method: string;
  params: unknown;
  result?: unknown;
  error?: string;
};

export type AcpClientEvents = {
  onSessionUpdate?: (
    run: AcpRun,
    sessionId: string,
    update: any,
    eventSeq: number,
  ) => void;
  onPermissionRequest?: (req: PermissionRequest) => void;
  onClientTool?: (run: AcpRun, event: ClientToolEvent) => void;
  onAgentStderr?: (line: string) => void;
};

export class AcpClient {
  private readonly db: Db;
  private readonly workspaceRoot: string;
  private readonly agentCommand: string;
  private readonly agentArgs: string[];
  private readonly toolAuth: ToolAuth | null;

  private readonly rpc: StdioProcess;
  private nextId = 1;

  private readonly pending = new Map<
    JsonRpcId,
    (res: JsonRpcResponse) => void
  >();

  // run-scoped state
  private currentRun: AcpRun | null = null;
  private readonly runSeq = new Map<string, number>();

  private readonly events: AcpClientEvents;

  constructor(params: {
    db: Db;
    workspaceRoot: string;
    agentCommand: string;
    agentArgs: string[];
    toolAuth?: ToolAuth;
    events?: AcpClientEvents;
    rpc?: StdioProcess;
  }) {
    this.db = params.db;
    this.workspaceRoot = params.workspaceRoot;
    this.agentCommand = params.agentCommand;
    this.agentArgs = params.agentArgs;
    this.toolAuth = params.toolAuth ?? null;
    this.events = params.events ?? {};

    this.rpc =
      params.rpc ?? spawnAcpAgent(this.agentCommand, this.agentArgs);
    this.rpc.onMessage((m) => this.handleMessage(m));
    this.rpc.onStderr((line) => this.events.onAgentStderr?.(line));
  }

  close(): void {
    this.rpc.kill();
  }

  private initPromise: Promise<InitializeResult> | null = null;

  async initialize(): Promise<InitializeResult> {
    if (this.initPromise) return this.initPromise;

    const params: InitializeParams = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: 'cli-gateway',
        title: 'cli-gateway',
        version: '0.1.0',
      },
    };

    this.initPromise = this.request<InitializeParams, InitializeResult>(
      'initialize',
      params,
    );

    return this.initPromise;
  }

  async newSession(params: NewSessionParams): Promise<NewSessionResult> {
    return this.request<NewSessionParams, NewSessionResult>(
      'session/new',
      params,
    );
  }

  async prompt(run: AcpRun, params: PromptParams): Promise<PromptResult> {
    this.currentRun = run;
    this.runSeq.set(run.runId, 0);

    try {
      const result = await this.request<PromptParams, PromptResult>(
        'session/prompt',
        params,
      );
      return result;
    } finally {
      this.currentRun = null;
      this.runSeq.delete(run.runId);
    }
  }

  notifyCancel(sessionId: string): void {
    this.rpc.write({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId },
    });
  }

  async respondPermission(
    req: PermissionRequest,
    decision: PermissionDecision,
  ): Promise<void> {
    const outcome: RequestPermissionResult['outcome'] =
      decision.kind === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: decision.optionId };

    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: req.requestId,
      result: { outcome },
    };

    this.rpc.write(msg);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const handler = this.pending.get(message.id);
      if (handler) {
        this.pending.delete(message.id);
        handler(message);
      }
      return;
    }

    if (isNotification(message)) {
      if (message.method === 'session/update') {
        const params = message.params as any;
        const sessionId = params?.sessionId as string | undefined;
        const update = params?.update;
        if (this.currentRun && sessionId) {
          const eventSeq = this.appendEvent(
            this.currentRun.runId,
            'session/update',
            params,
          );
          void this.events.onSessionUpdate?.(
            this.currentRun,
            sessionId,
            update,
            eventSeq,
          );
        }
      }
      return;
    }

    if (isRequest(message)) {
      // Agent -> Client requests
      void this.handleAgentRequest(message);
      return;
    }
  }

  private async handleAgentRequest(req: JsonRpcRequest): Promise<void> {
    const run = this.currentRun;

    const emitTool = (event: ClientToolEvent) => {
      if (!run) return;
      this.events.onClientTool?.(run, event);
    };

    try {
      switch (req.method) {
        case 'session/request_permission': {
          const params = req.params as RequestPermissionParams;
          const sessionKey = this.currentRun?.sessionKey ?? 'unknown';
          const pr: PermissionRequest = {
            requestId: req.id,
            sessionKey,
            sessionId: params.sessionId,
            params,
            createdAtMs: Date.now(),
          };
          this.events.onPermissionRequest?.(pr);
          return;
        }

        case 'fs/read_text_file': {
          const params = req.params as FsReadTextFileParams;
          emitTool({ phase: 'start', method: req.method, params });

          this.assertAuthorized('read');
          const resolvedPath = resolveWorkspacePath(
            this.workspaceRoot,
            params.path,
          );
          const content = readTextFileWithLimit(
            resolvedPath,
            params.line,
            params.limit,
          );
          this.respond(req.id, { content } satisfies FsReadTextFileResult);

          emitTool({
            phase: 'end',
            method: req.method,
            params,
            result: { bytes: content.length },
          });
          return;
        }

        case 'fs/write_text_file': {
          const params = req.params as FsWriteTextFileParams;
          emitTool({ phase: 'start', method: req.method, params: { path: params.path } });

          this.assertAuthorized('edit');
          const resolvedPath = resolveWorkspacePath(
            this.workspaceRoot,
            params.path,
          );
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
          fs.writeFileSync(resolvedPath, params.content, 'utf8');
          this.respond(req.id, {});

          emitTool({
            phase: 'end',
            method: req.method,
            params: { path: params.path },
            result: { bytes: params.content.length },
          });
          return;
        }

        case 'terminal/create': {
          const params = req.params as TerminalCreateParams;
          emitTool({
            phase: 'start',
            method: req.method,
            params: {
              command: params.command,
              args: params.args,
              cwd: params.cwd,
            },
          });

          this.assertAuthorized('execute');
          const terminalId = await this.terminalCreate(params);
          this.respond(req.id, { terminalId } satisfies TerminalCreateResult);

          emitTool({
            phase: 'end',
            method: req.method,
            params: {
              command: params.command,
              args: params.args,
              cwd: params.cwd,
            },
            result: { terminalId },
          });
          return;
        }

        case 'terminal/output': {
          const params = req.params as TerminalOutputParams;
          const out = this.terminalOutput(params);
          this.respond(req.id, out satisfies TerminalOutputResult);
          return;
        }

        case 'terminal/wait_for_exit': {
          const params = req.params as TerminalWaitForExitParams;
          emitTool({
            phase: 'start',
            method: req.method,
            params: { terminalId: params.terminalId },
          });

          const res = await this.terminalWaitForExit(params);
          this.respond(req.id, res);

          emitTool({
            phase: 'end',
            method: req.method,
            params: { terminalId: params.terminalId },
            result: res,
          });
          return;
        }

        case 'terminal/kill': {
          const params = req.params as TerminalKillParams;
          this.assertAuthorized('execute');
          this.terminalKill(params);
          this.respond(req.id, {});
          return;
        }

        case 'terminal/release': {
          const params = req.params as TerminalReleaseParams;
          this.terminalRelease(params);
          this.respond(req.id, {});
          return;
        }

        default: {
          this.respondError(req.id, -32601, `Method not found: ${req.method}`);
        }
      }
    } catch (error: any) {
      log.error('Agent request handler error', req.method, error);
      emitTool({
        phase: 'error',
        method: req.method,
        params: req.params,
        error: String(error?.message ?? error),
      });
      this.respondError(req.id, -32000, String(error?.message ?? error));
    }
  }

  private request<TParams, TResult>(
    method: string,
    params: TParams,
  ): Promise<TResult> {
    const id = this.nextId++;

    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    this.rpc.write(req);

    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, (res) => {
        if ('error' in res) {
          reject(new Error(res.error.message));
          return;
        }
        resolve(res.result as TResult);
      });
    });
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.rpc.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.rpc.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private appendEvent(runId: string, method: string, payload: unknown): number {
    const prev = this.runSeq.get(runId) ?? 0;
    const seq = prev + 1;
    this.runSeq.set(runId, seq);

    this.db
      .prepare(
        'INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)',
      )
      .run(runId, seq, method, JSON.stringify(payload), Date.now());

    return seq;
  }

  private assertAuthorized(kind: ToolKind): void {
    const sessionKey = this.currentRun?.sessionKey;

    // Tool calls should only occur within a prompt turn.
    if (!sessionKey) {
      throw new Error(
        `Tool call not allowed outside prompt turn (kind=${kind})`,
      );
    }

    // If auth is not wired, default deny (secure by default).
    if (!this.toolAuth) {
      throw new Error(`Tool call denied (no ToolAuth): ${kind}`);
    }

    const ok = this.toolAuth.consume(sessionKey, kind);
    if (!ok) {
      throw new Error(`Tool call denied by policy: ${kind}`);
    }
  }

  // terminal management (minimal)

  private readonly terminals = new Map<
    string,
    {
      child: ReturnType<typeof spawn>;
      output: string;
      truncated: boolean;
      byteLimit: number;
    }
  >();

  private async terminalCreate(params: TerminalCreateParams): Promise<string> {
    const terminalId = randomUUID();
    const cwd = params.cwd
      ? resolveWorkspacePath(this.workspaceRoot, params.cwd)
      : this.workspaceRoot;

    const byteLimit = params.outputByteLimit ?? 256_000;

    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env: {
        ...process.env,
        ...(params.env ?? []).reduce<Record<string, string>>((acc, kv) => {
          acc[kv.name] = kv.value;
          return acc;
        }, {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state = { child, output: '', truncated: false, byteLimit };
    this.terminals.set(terminalId, state);

    const onData = (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      state.output += chunk;
      if (state.output.length > state.byteLimit) {
        state.output = state.output.slice(
          state.output.length - state.byteLimit,
        );
        state.truncated = true;
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    return terminalId;
  }

  private terminalOutput(params: TerminalOutputParams): TerminalOutputResult {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);

    const exitStatus =
      state.child.exitCode !== null || state.child.signalCode !== null
        ? { exitCode: state.child.exitCode, signal: state.child.signalCode }
        : null;

    return {
      output: state.output,
      truncated: state.truncated,
      exitStatus,
    };
  }

  private terminalWaitForExit(
    params: TerminalWaitForExitParams,
  ): Promise<{ exitCode?: number | null; signal?: string | null }> {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);

    return new Promise((resolve) => {
      state.child.once('exit', (code, signal) => {
        resolve({ exitCode: code, signal });
      });
    });
  }

  private terminalKill(params: TerminalKillParams): void {
    const state = this.terminals.get(params.terminalId);
    if (!state) throw new Error(`Unknown terminalId: ${params.terminalId}`);
    state.child.kill('SIGKILL');
  }

  private terminalRelease(params: TerminalReleaseParams): void {
    const state = this.terminals.get(params.terminalId);
    if (!state) return;
    state.child.kill('SIGKILL');
    this.terminals.delete(params.terminalId);
  }
}

function readTextFileWithLimit(
  filePath: string,
  line?: number,
  limit?: number,
): string {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!line || !limit) return content;

  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, line - 1);
  return lines.slice(startIndex, startIndex + limit).join('\n');
}
