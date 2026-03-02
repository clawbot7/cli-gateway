import { randomUUID } from 'node:crypto';

import type { Db } from '../db/db.js';
import { log } from '../logging.js';
import type { AppConfig } from '../config.js';
import {
  createRun,
  createSession,
  deleteBinding,
  finishRun,
  getBinding,
  getSession,
  updateAcpSessionId,
  upsertBinding,
  type ConversationKey,
  bindingKeyFromConversationKey,
} from './sessionStore.js';
import {
  createJob,
  deleteJob,
  listJobsForBinding,
  setJobEnabled,
} from '../db/jobStore.js';
import { AcpClient, type PermissionRequest } from '../acp/client.js';

export type OutboundSink = {
  sendText: (text: string) => Promise<void>;
};

export class GatewayRouter {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly client: AcpClient;
  private readonly onJobsChanged?: () => void;

  private readonly pendingPermission = new Map<string, PermissionRequest>();

  // Ensure the single ACP stdio process never multiplexes conversations.
  private queue = Promise.resolve();

  private currentConversationKey: ConversationKey | null = null;
  private currentSink: OutboundSink | null = null;

  constructor(params: {
    db: Db;
    config: AppConfig;
    onJobsChanged?: () => void;
  }) {
    this.db = params.db;
    this.config = params.config;
    this.onJobsChanged = params.onJobsChanged;

    this.client = new AcpClient({
      db: this.db,
      workspaceRoot: this.config.workspaceRoot,
      agentCommand: this.config.acpAgentCommand,
      agentArgs: this.config.acpAgentArgs,
      events: {
        onSessionUpdate: async (_run, _sessionId, update) => {
          const sink = this.currentSink;
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
          const key = this.currentConversationKey;
          const sink = this.currentSink;
          if (!key || !sink) return;

          const keyStr = conversationKeyString(key);
          this.pendingPermission.set(keyStr, req);
          void sink.sendText(formatPermissionRequest(req));
        },
        onAgentStderr: (line) => {
          log.debug('[agent stderr]', line);
        },
      },
    });
  }

  async start(): Promise<void> {
    const init = await this.client.initialize();
    log.info('ACP initialized', {
      protocolVersion: init.protocolVersion,
      loadSession: init.agentCapabilities?.loadSession,
    });
  }

  close(): void {
    this.client.close();
  }

  private async ensureSession(
    key: ConversationKey,
  ): Promise<{ sessionKey: string; acpSessionId: string }> {
    const binding = getBinding(this.db, key);

    let sessionKey: string;
    if (binding) {
      sessionKey = binding.sessionKey;
    } else {
      sessionKey = randomUUID();
      const init = await this.client.initialize();
      createSession(this.db, {
        sessionKey,
        agentCommand: this.config.acpAgentCommand,
        agentArgs: this.config.acpAgentArgs,
        cwd: this.config.workspaceRoot,
        loadSupported: Boolean(init.agentCapabilities?.loadSession),
      });

      const newSession = await this.client.newSession({
        cwd: this.config.workspaceRoot,
        mcpServers: [],
      });
      updateAcpSessionId(this.db, sessionKey, newSession.sessionId);
      upsertBinding(this.db, key, sessionKey);
    }

    const sess = getSession(this.db, sessionKey);
    const acpSessionId = sess?.acpSessionId;
    if (!acpSessionId) {
      throw new Error('Missing acp_session_id');
    }

    return { sessionKey, acpSessionId };
  }

  private async handleCommand(
    key: ConversationKey,
    text: string,
    sink: OutboundSink,
  ): Promise<boolean> {
    if (!text.startsWith('/')) return false;

    const parts = text.trim().split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case '/new': {
        deleteBinding(this.db, key);
        await sink.sendText(
          'OK: binding cleared. Next message creates a new session.',
        );
        return true;
      }

      case '/allow': {
        const idx = Number(parts[1] ?? '');
        if (!Number.isFinite(idx) || idx < 1) {
          await sink.sendText('Usage: /allow <n>');
          return true;
        }
        const pr = this.pendingPermission.get(conversationKeyString(key));
        if (!pr) {
          await sink.sendText('No pending permission request.');
          return true;
        }
        const opt = pr.params.options[idx - 1];
        if (!opt) {
          await sink.sendText(`Invalid option index: ${idx}`);
          return true;
        }
        await this.client.respondPermission(pr, {
          kind: 'selected',
          optionId: opt.optionId,
        });
        this.pendingPermission.delete(conversationKeyString(key));
        await sink.sendText(`OK: selected option ${idx} (${opt.name})`);
        return true;
      }

      case '/deny': {
        const pr = this.pendingPermission.get(conversationKeyString(key));
        if (!pr) {
          await sink.sendText('No pending permission request.');
          return true;
        }

        const rejectOnce = pr.params.options.find(
          (o) => o.kind === 'reject_once',
        );
        if (rejectOnce) {
          await this.client.respondPermission(pr, {
            kind: 'selected',
            optionId: rejectOnce.optionId,
          });
          this.pendingPermission.delete(conversationKeyString(key));
          await sink.sendText(`OK: selected reject_once (${rejectOnce.name})`);
          return true;
        }

        await this.client.respondPermission(pr, { kind: 'cancelled' });
        this.pendingPermission.delete(conversationKeyString(key));
        await sink.sendText('OK: cancelled permission request.');
        return true;
      }

      case '/cron': {
        const sub = parts[1];
        const bindingKey = bindingKeyFromConversationKey(key);

        if (!sub || sub === 'help') {
          await sink.sendText(
            [
              'Usage:',
              '/cron list',
              '/cron add <m h dom mon dow> <prompt...>',
              '/cron del <jobId>',
              '/cron enable <jobId>',
              '/cron disable <jobId>',
              '',
              'Template vars: {{now_iso}} {{date}}',
            ].join('\n'),
          );
          return true;
        }

        if (sub === 'list') {
          const jobs = listJobsForBinding(this.db, bindingKey);
          if (!jobs.length) {
            await sink.sendText('No jobs for this conversation.');
            return true;
          }

          await sink.sendText(
            jobs
              .map(
                (j) =>
                  `- ${j.jobId} enabled=${j.enabled ? '1' : '0'} cron="${j.cronExpr}" template="${truncate(j.promptTemplate, 80)}"`,
              )
              .join('\n'),
          );
          return true;
        }

        if (sub === 'add') {
          // Ensure binding exists so scheduler knows where to deliver.
          await this.ensureSession(key);

          // Expect 5 cron fields then prompt text.
          const cronExpr = parts.slice(2, 7).join(' ');
          const promptTemplate = parts.slice(7).join(' ');

          if (
            !cronExpr ||
            cronExpr.split(' ').filter(Boolean).length < 5 ||
            !promptTemplate
          ) {
            await sink.sendText(
              'Usage: /cron add <m h dom mon dow> <prompt...>',
            );
            return true;
          }

          const jobId = createJob(this.db, {
            bindingKey,
            cronExpr,
            promptTemplate,
          });
          this.onJobsChanged?.();
          await sink.sendText(`OK: job created ${jobId}`);
          return true;
        }

        if (sub === 'del') {
          const jobId = parts[2];
          if (!jobId) {
            await sink.sendText('Usage: /cron del <jobId>');
            return true;
          }
          deleteJob(this.db, jobId);
          this.onJobsChanged?.();
          await sink.sendText(`OK: job deleted ${jobId}`);
          return true;
        }

        if (sub === 'enable' || sub === 'disable') {
          const jobId = parts[2];
          if (!jobId) {
            await sink.sendText(`Usage: /cron ${sub} <jobId>`);
            return true;
          }
          setJobEnabled(this.db, jobId, sub === 'enable');
          this.onJobsChanged?.();
          await sink.sendText(`OK: job ${sub}d ${jobId}`);
          return true;
        }

        await sink.sendText('Unknown /cron subcommand. Try /cron help');
        return true;
      }

      default:
        return false;
    }
  }

  handleUserMessage(
    key: ConversationKey,
    text: string,
    sink: OutboundSink,
  ): Promise<void> {
    this.queue = this.queue.then(async () => {
      this.currentConversationKey = key;
      this.currentSink = sink;

      try {
        const commandHandled = await this.handleCommand(key, text, sink);
        if (commandHandled) return;

        const { sessionKey, acpSessionId } = await this.ensureSession(key);

        const runId = randomUUID();
        createRun(this.db, { runId, sessionKey, promptText: text });

        const run = { runId, sessionKey, createdAtMs: Date.now() };

        const result = await this.client.prompt(run, {
          sessionId: acpSessionId,
          prompt: [{ type: 'text', text }],
        });

        finishRun(this.db, { runId, stopReason: result.stopReason });
      } catch (error: any) {
        // best-effort record
        log.error('handleUserMessage error', error);
        await sink.sendText(`Error: ${String(error?.message ?? error)}`);
      } finally {
        this.currentConversationKey = null;
        this.currentSink = null;
      }
    });

    return this.queue;
  }
}

function conversationKeyString(key: ConversationKey): string {
  return [key.platform, key.chatId, key.threadId ?? '-', key.userId].join(':');
}

function formatPermissionRequest(req: PermissionRequest): string {
  const options = req.params.options
    .map((o, i) => `${i + 1}. ${o.name} (${o.kind})`)
    .join('\n');

  return `\n[permission required]\nTool: ${req.params.toolCall?.title ?? req.params.toolCall?.toolCallId ?? 'tool_call'}\n${options}\nReply with /allow <n> or /deny`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}
