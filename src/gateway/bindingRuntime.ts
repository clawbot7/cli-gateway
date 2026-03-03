import { log } from '../logging.js';
import type { Db } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { OutboundSink, UiMode } from './types.js';
import { AcpClient, type PermissionRequest } from '../acp/client.js';
import type { InitializeResult } from '../acp/types.js';
import { updateAcpSessionId, updateLoadSupported } from './sessionStore.js';
import { ToolAuth, type ToolKind } from './toolAuth.js';

export class BindingRuntime {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly toolAuth: ToolAuth;
  private readonly sessionKey: string;
  private readonly bindingKey: string;

  private readonly client: AcpClient;
  private init: InitializeResult | null = null;

  private acpSessionId: string | null = null;

  private queue: Promise<unknown> = Promise.resolve();
  private activeSink: OutboundSink | null = null;

  private pendingPermission: PermissionRequest | null = null;

  private currentRunId: string | null = null;
  private currentRunLastSeq = 0;
  private currentUiMode: UiMode = 'verbose';

  constructor(params: {
    db: Db;
    config: AppConfig;
    toolAuth: ToolAuth;
    sessionKey: string;
    bindingKey: string;
  }) {
    this.db = params.db;
    this.config = params.config;
    this.toolAuth = params.toolAuth;
    this.sessionKey = params.sessionKey;
    this.bindingKey = params.bindingKey;

    this.client = new AcpClient({
      db: this.db,
      workspaceRoot: this.config.workspaceRoot,
      agentCommand: this.config.acpAgentCommand,
      agentArgs: this.config.acpAgentArgs,
      toolAuth: this.toolAuth,
      events: {
        onSessionUpdate: async (run, _sessionId, update, eventSeq) => {
          if (run.runId === this.currentRunId) {
            this.currentRunLastSeq = Math.max(this.currentRunLastSeq, eventSeq);
          }

          const sink = this.activeSink;
          if (!sink) return;

          if (update?.sessionUpdate === 'agent_message_chunk') {
            const block = update?.content;
            const text = block?.text ?? '';
            if (!text) return;
            await sink.sendText(text);
          }

          if (update?.sessionUpdate === 'plan') {
            const detail = renderJson(update, this.config.uiJsonMaxChars);
            if (sink.sendUi) {
              await sink.sendUi({
                kind: 'plan',
                mode: this.currentUiMode,
                title: 'Plan updated',
                detail: this.currentUiMode === 'verbose' ? detail : undefined,
              });
            } else {
              await sink.sendText(
                this.currentUiMode === 'verbose'
                  ? `\n[plan]\n${detail}\n`
                  : '\n[plan updated]\n',
              );
            }
          }

          if (update?.sessionUpdate === 'task') {
            const detail = renderJson(update, this.config.uiJsonMaxChars);
            if (sink.sendUi) {
              await sink.sendUi({
                kind: 'task',
                mode: this.currentUiMode,
                title: 'Task update',
                detail: this.currentUiMode === 'verbose' ? detail : undefined,
              });
            } else {
              await sink.sendText(
                this.currentUiMode === 'verbose'
                  ? `\n[task]\n${detail}\n`
                  : '\n[task updated]\n',
              );
            }
          }
        },
        onClientTool: (run, event) => {
          const sink = this.activeSink;
          if (!sink) return;

          if (run.runId !== this.currentRunId) return;

          const title = `${event.method} (${event.phase})`;
          const detail =
            this.currentUiMode === 'verbose'
              ? renderJson(
                  { params: event.params, result: event.result, error: event.error },
                  this.config.uiJsonMaxChars,
                )
              : undefined;

          if (sink.sendUi) {
            void sink.sendUi({
              kind: 'tool',
              mode: this.currentUiMode,
              title,
              detail,
            });
            return;
          }

          void sink.sendText(
            this.currentUiMode === 'verbose'
              ? `\n[tool] ${title}\n${detail ?? ''}\n`
              : `\n[tool] ${title}`,
          );
        },
        onPermissionRequest: (req) => {
          const sink = this.activeSink;
          if (!sink) return;

          this.pendingPermission = req;

          const toolKind = toToolKind(req.params.toolCall?.kind);
          if (toolKind) {
            const policy = this.toolAuth.getPersistentPolicy(
              this.bindingKey,
              toolKind,
            );
            if (policy === 'allow') {
              const option = req.params.options.find(
                (o) => o.kind === 'allow_always' || o.kind === 'allow_once',
              );
              if (option) {
                this.toolAuth.grantOnce(this.sessionKey, toolKind, 1);
                void this.client.respondPermission(req, {
                  kind: 'selected',
                  optionId: option.optionId,
                });
                this.pendingPermission = null;
                void sink.sendText(`[permission] auto-allowed (${toolKind})`);
                return;
              }
            }
            if (policy === 'reject') {
              const option = req.params.options.find(
                (o) => o.kind === 'reject_always' || o.kind === 'reject_once',
              );
              if (option) {
                void this.client.respondPermission(req, {
                  kind: 'selected',
                  optionId: option.optionId,
                });
                this.pendingPermission = null;
                void sink.sendText(`[permission] auto-rejected (${toolKind})`);
                return;
              }
            }
          }

          const title =
            req.params.toolCall?.title ??
            req.params.toolCall?.toolCallId ??
            'tool_call';

          if (sink.requestPermission) {
            void sink.requestPermission({
              uiMode: this.currentUiMode,
              sessionKey: this.sessionKey,
              requestId: String(req.requestId),
              toolTitle: title,
              toolKind: toolKind ?? null,
            });
            return;
          }

          void sink.sendText(formatPermissionRequest(req));
        },
        onAgentStderr: (line) => {
          log.debug('[agent stderr]', line);
        },
      },
    });
  }

  close(): void {
    this.client.close();
  }

  async ensureInitialized(): Promise<InitializeResult> {
    if (this.init) return this.init;
    this.init = await this.client.initialize();
    updateLoadSupported(
      this.db,
      this.sessionKey,
      Boolean(this.init.agentCapabilities?.loadSession),
    );

    log.info('ACP initialized (runtime)', {
      bindingKey: this.bindingKey,
      protocolVersion: this.init.protocolVersion,
    });
    return this.init;
  }

  async ensureSessionId(): Promise<string> {
    if (this.acpSessionId) return this.acpSessionId;

    await this.ensureInitialized();

    const newSession = await this.client.newSession({
      cwd: this.config.workspaceRoot,
      mcpServers: [],
    });

    this.acpSessionId = newSession.sessionId;
    updateAcpSessionId(this.db, this.sessionKey, this.acpSessionId);
    return this.acpSessionId;
  }

  getLoadSupported(): boolean {
    return Boolean(this.init?.agentCapabilities?.loadSession);
  }

  getPendingPermission(): PermissionRequest | null {
    return this.pendingPermission;
  }

  async selectPermissionOption(idx: number, sink: OutboundSink): Promise<void> {
    const pr = this.pendingPermission;
    if (!pr) {
      await sink.sendText('No pending permission request.');
      return;
    }

    const opt = pr.params.options[idx - 1];
    if (!opt) {
      await sink.sendText(`Invalid option index: ${idx}`);
      return;
    }

    const toolKind = toToolKind(pr.params.toolCall?.kind);
    if (toolKind) {
      if (opt.kind === 'allow_always') {
        this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'allow');
      }
      if (opt.kind === 'reject_always') {
        this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'reject');
      }
      if (opt.kind === 'allow_once' || opt.kind === 'allow_always') {
        this.toolAuth.grantOnce(this.sessionKey, toolKind, 1);
      }
    }

    await this.client.respondPermission(pr, {
      kind: 'selected',
      optionId: opt.optionId,
    });

    this.pendingPermission = null;
    await sink.sendText(`OK: selected option ${idx} (${opt.name})`);
  }

  hasSessionId(): boolean {
    return Boolean(this.acpSessionId);
  }

  async decidePermission(params: {
    decision: 'allow' | 'deny';
    requestId?: string;
  }): Promise<{ ok: boolean; message: string }> {
    const pr = this.pendingPermission;
    if (!pr) {
      return { ok: false, message: 'No pending permission request.' };
    }

    if (params.requestId && String(pr.requestId) !== params.requestId) {
      return { ok: false, message: 'Permission request expired.' };
    }

    const toolKind = toToolKind(pr.params.toolCall?.kind);

    const allowOnce = pr.params.options.find((o) => o.kind === 'allow_once');
    const allowAlways = pr.params.options.find((o) => o.kind === 'allow_always');

    const rejectOnce = pr.params.options.find((o) => o.kind === 'reject_once');
    const rejectAlways = pr.params.options.find((o) => o.kind === 'reject_always');

    const selected =
      params.decision === 'allow'
        ? (allowOnce ?? allowAlways)
        : (rejectOnce ?? rejectAlways);

    if (selected && toolKind && selected.kind === 'allow_always') {
      this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'allow');
    }

    if (selected && toolKind && selected.kind === 'reject_always') {
      this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'reject');
    }

    if (selected && toolKind && (selected.kind === 'allow_once' || selected.kind === 'allow_always')) {
      this.toolAuth.grantOnce(this.sessionKey, toolKind, 1);
    }

    if (selected) {
      await this.client.respondPermission(pr, {
        kind: 'selected',
        optionId: selected.optionId,
      });
      this.pendingPermission = null;

      return {
        ok: true,
        message:
          params.decision === 'allow'
            ? 'OK: allowed.'
            : 'OK: denied.',
      };
    }

    await this.client.respondPermission(pr, { kind: 'cancelled' });
    this.pendingPermission = null;
    return { ok: true, message: 'OK: cancelled permission request.' };
  }

  async denyPermission(sink: OutboundSink): Promise<void> {
    const res = await this.decidePermission({ decision: 'deny' });
    await sink.sendText(res.message);
  }

  prompt(params: {
    runId: string;
    promptText: string;
    sink: OutboundSink;
    uiMode: UiMode;
    contextText?: string;
  }): Promise<{ stopReason: string; lastSeq: number }> {
    const next = this.queue.then(async () => {
      const isFreshSession = !this.acpSessionId;
      const sessionId = await this.ensureSessionId();

      this.currentRunId = params.runId;
      this.currentRunLastSeq = 0;
      this.currentUiMode = params.uiMode;
      this.activeSink = params.sink;

      try {
        const run = {
          runId: params.runId,
          sessionKey: this.sessionKey,
          createdAtMs: Date.now(),
        };

        const blocks = [] as Array<{ type: 'text'; text: string }>;

        if (isFreshSession && params.contextText?.trim()) {
          blocks.push({ type: 'text', text: params.contextText });
        }

        blocks.push({ type: 'text', text: params.promptText });

        const result = await this.client.prompt(run, {
          sessionId,
          prompt: blocks,
        });

        return { stopReason: result.stopReason, lastSeq: this.currentRunLastSeq };
      } finally {
        this.activeSink = null;
        this.currentRunId = null;
        this.currentUiMode = 'verbose';
      }
    });

    // Keep the queue alive even if this prompt fails.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  }
}

function toToolKind(kind: unknown): ToolKind | null {
  if (typeof kind !== 'string') return null;

  const allowed: ToolKind[] = [
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other',
  ];

  return allowed.includes(kind as ToolKind) ? (kind as ToolKind) : null;
}

function formatPermissionRequest(req: PermissionRequest): string {
  const options = req.params.options
    .map((o, i) => `${i + 1}. ${o.name} (${o.kind})`)
    .join('\n');

  return `\n[permission required]\nTool: ${req.params.toolCall?.title ?? req.params.toolCall?.toolCallId ?? 'tool_call'}\n${options}\nReply with /allow <n> or /deny`;
}

function renderJson(value: unknown, maxChars: number): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 3) + '...';
  } catch {
    return String(value);
  }
}
