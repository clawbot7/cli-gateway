import { randomUUID } from 'node:crypto';

import type { Db } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import {
  bindingKeyFromConversationKey,
  createRun,
  createSession,
  deleteBinding,
  finishRun,
  getBinding,
  getSession,
  upsertBinding,
  type ConversationKey,
} from './sessionStore.js';
import {
  createJob,
  deleteJob,
  listJobsForBinding,
  setJobEnabled,
} from '../db/jobStore.js';
import { ToolAuth } from './toolAuth.js';
import { BindingRuntime } from './bindingRuntime.js';
import type { OutboundSink } from './types.js';

export type { OutboundSink } from './types.js';

export class GatewayRouter {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly toolAuth: ToolAuth;
  private readonly onJobsChanged?: () => void;

  private readonly runtimesBySessionKey = new Map<string, BindingRuntime>();

  constructor(params: {
    db: Db;
    config: AppConfig;
    onJobsChanged?: () => void;
  }) {
    this.db = params.db;
    this.config = params.config;
    this.onJobsChanged = params.onJobsChanged;
    this.toolAuth = new ToolAuth(this.db);
  }

  async start(): Promise<void> {
    log.info('GatewayRouter ready');
  }

  close(): void {
    for (const rt of this.runtimesBySessionKey.values()) {
      rt.close();
    }
    this.runtimesBySessionKey.clear();
  }

  private ensureBindingExists(key: ConversationKey): {
    bindingKey: string;
    sessionKey: string;
  } {
    const bindingKey = bindingKeyFromConversationKey(key);
    const existing = getBinding(this.db, key);
    if (existing) return { bindingKey, sessionKey: existing.sessionKey };

    const sessionKey = randomUUID();

    // Create a minimal session row; runtime will update loadSupported after initialize.
    createSession(this.db, {
      sessionKey,
      agentCommand: this.config.acpAgentCommand,
      agentArgs: this.config.acpAgentArgs,
      cwd: this.config.workspaceRoot,
      loadSupported: false,
    });

    upsertBinding(this.db, key, sessionKey);

    return { bindingKey, sessionKey };
  }

  private getOrCreateRuntime(params: {
    sessionKey: string;
    bindingKey: string;
  }): BindingRuntime {
    const existing = this.runtimesBySessionKey.get(params.sessionKey);
    if (existing) return existing;

    const rt = new BindingRuntime({
      db: this.db,
      config: this.config,
      toolAuth: this.toolAuth,
      sessionKey: params.sessionKey,
      bindingKey: params.bindingKey,
    });

    this.runtimesBySessionKey.set(params.sessionKey, rt);
    return rt;
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
        const existing = getBinding(this.db, key);
        if (existing) {
          const rt = this.runtimesBySessionKey.get(existing.sessionKey);
          rt?.close();
          this.runtimesBySessionKey.delete(existing.sessionKey);
        }

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

        const binding = getBinding(this.db, key);
        if (!binding) {
          await sink.sendText('No session binding. Send a message first.');
          return true;
        }

        const bindingKey = bindingKeyFromConversationKey(key);
        const rt = this.getOrCreateRuntime({
          sessionKey: binding.sessionKey,
          bindingKey,
        });

        await rt.selectPermissionOption(idx, sink);
        return true;
      }

      case '/deny': {
        const binding = getBinding(this.db, key);
        if (!binding) {
          await sink.sendText('No session binding. Send a message first.');
          return true;
        }

        const bindingKey = bindingKeyFromConversationKey(key);
        const rt = this.getOrCreateRuntime({
          sessionKey: binding.sessionKey,
          bindingKey,
        });

        await rt.denyPermission(sink);
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
          this.ensureBindingExists(key);

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

  async handleUserMessage(
    key: ConversationKey,
    text: string,
    sink: OutboundSink,
  ): Promise<void> {
    const commandHandled = await this.handleCommand(key, text, sink);
    if (commandHandled) return;

    const { bindingKey, sessionKey } = this.ensureBindingExists(key);
    const rt = this.getOrCreateRuntime({ sessionKey, bindingKey });

    // Ensure session row exists (cron may have created binding+session already).
    const sess = getSession(this.db, sessionKey);
    if (!sess) {
      createSession(this.db, {
        sessionKey,
        agentCommand: this.config.acpAgentCommand,
        agentArgs: this.config.acpAgentArgs,
        cwd: this.config.workspaceRoot,
        loadSupported: false,
      });
    }

    const runId = randomUUID();
    createRun(this.db, { runId, sessionKey, promptText: text });

    try {
      const stopReason = await rt.prompt({
        runId,
        promptText: text,
        sink,
      });

      finishRun(this.db, { runId, stopReason });
    } catch (error: any) {
      finishRun(this.db, { runId, error: String(error?.message ?? error) });
      await sink.sendText(`Error: ${String(error?.message ?? error)}`);
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}
