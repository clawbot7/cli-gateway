import { log } from '../logging.js';
import type { Db } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { OutboundSink } from './types.js';
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
        onSessionUpdate: async (_run, _sessionId, update) => {
          const sink = this.activeSink;
          if (!sink) return;

          if (update?.sessionUpdate === 'agent_message_chunk') {
            const block = update?.content;
            const text = block?.text ?? '';
            if (!text) return;
            await sink.sendText(text);
          }

          if (
            update?.sessionUpdate === 'tool_call' ||
            update?.sessionUpdate === 'tool_call_update'
          ) {
            await sink.sendText(
              `\n[tool] ${update?.title ?? update?.toolCallId ?? 'tool_call'}`,
            );
          }

          if (update?.sessionUpdate === 'plan') {
            await sink.sendText('\n[plan]\n');
          }
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

  async denyPermission(sink: OutboundSink): Promise<void> {
    const pr = this.pendingPermission;
    if (!pr) {
      await sink.sendText('No pending permission request.');
      return;
    }

    const toolKind = toToolKind(pr.params.toolCall?.kind);

    const rejectOnce = pr.params.options.find((o) => o.kind === 'reject_once');
    const rejectAlways = pr.params.options.find(
      (o) => o.kind === 'reject_always',
    );
    const selected = rejectOnce ?? rejectAlways;

    if (selected && toolKind && selected.kind === 'reject_always') {
      this.toolAuth.setPersistentPolicy(this.bindingKey, toolKind, 'reject');
    }

    if (selected) {
      await this.client.respondPermission(pr, {
        kind: 'selected',
        optionId: selected.optionId,
      });
      this.pendingPermission = null;
      await sink.sendText(`OK: selected ${selected.kind} (${selected.name})`);
      return;
    }

    await this.client.respondPermission(pr, { kind: 'cancelled' });
    this.pendingPermission = null;
    await sink.sendText('OK: cancelled permission request.');
  }

  prompt(params: {
    runId: string;
    promptText: string;
    sink: OutboundSink;
  }): Promise<string> {
    const next = this.queue.then(async () => {
      const sessionId = await this.ensureSessionId();

      this.activeSink = params.sink;
      try {
        const run = {
          runId: params.runId,
          sessionKey: this.sessionKey,
          createdAtMs: Date.now(),
        };

        const result = await this.client.prompt(run, {
          sessionId,
          prompt: [{ type: 'text', text: params.promptText }],
        });

        return result.stopReason;
      } finally {
        this.activeSink = null;
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
