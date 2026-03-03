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
import { upsertDeliveryCheckpoint } from '../db/deliveryCheckpointStore.js';
import { ToolAuth } from './toolAuth.js';
import { BindingRuntime } from './bindingRuntime.js';
import type { OutboundSink } from './types.js';
import { buildReplayContextFromRecentRuns } from './history.js';

export type { OutboundSink } from './types.js';

export class GatewayRouter {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly toolAuth: ToolAuth;
  private readonly onJobsChanged?: () => void;

  private readonly runtimesBySessionKey = new Map<
    string,
    { runtime: BindingRuntime; lastUsedMs: number }
  >();

  private gcTimer: NodeJS.Timeout | null = null;

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
    this.gcTimer = setInterval(() => {
      try {
        this.gc();
      } catch (error) {
        log.warn('runtime GC error', error);
      }
    }, 60_000);

    log.info('GatewayRouter ready');
  }

  close(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }

    for (const entry of this.runtimesBySessionKey.values()) {
      entry.runtime.close();
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
    if (existing) {
      existing.lastUsedMs = Date.now();
      return existing.runtime;
    }

    const rt = new BindingRuntime({
      db: this.db,
      config: this.config,
      toolAuth: this.toolAuth,
      sessionKey: params.sessionKey,
      bindingKey: params.bindingKey,
    });

    this.runtimesBySessionKey.set(params.sessionKey, {
      runtime: rt,
      lastUsedMs: Date.now(),
    });

    this.enforceRuntimeLimit();

    return rt;
  }

  private gc(): void {
    const now = Date.now();
    const ttlMs = this.config.runtimeIdleTtlSeconds * 1000;

    for (const [sessionKey, entry] of this.runtimesBySessionKey.entries()) {
      if (now - entry.lastUsedMs <= ttlMs) continue;
      entry.runtime.close();
      this.runtimesBySessionKey.delete(sessionKey);
    }

    this.enforceRuntimeLimit();
  }

  private enforceRuntimeLimit(): void {
    const max = this.config.maxBindingRuntimes;
    if (this.runtimesBySessionKey.size <= max) return;

    const entries = [...this.runtimesBySessionKey.entries()].sort(
      (a, b) => a[1].lastUsedMs - b[1].lastUsedMs,
    );

    const removeCount = Math.max(0, entries.length - max);
    for (let i = 0; i < removeCount; i += 1) {
      const [sessionKey, entry] = entries[i];
      entry.runtime.close();
      this.runtimesBySessionKey.delete(sessionKey);
    }
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
          const entry = this.runtimesBySessionKey.get(existing.sessionKey);
          entry?.runtime.close();
          this.runtimesBySessionKey.delete(existing.sessionKey);
        }

        deleteBinding(this.db, key);
        await sink.sendText(
          'OK: binding cleared. Next message creates a new session.',
        );
        return true;
      }

      case '/last': {
        const binding = getBinding(this.db, key);
        if (!binding) {
          await sink.sendText('No session binding. Send a message first.');
          return true;
        }

        const lastRun = this.db
          .prepare(
            'SELECT run_id as runId, stop_reason as stopReason, error FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1',
          )
          .get(binding.sessionKey) as
          | { runId: string; stopReason: string | null; error: string | null }
          | undefined;

        if (!lastRun) {
          await sink.sendText('No runs for this session yet.');
          return true;
        }

        const rows = this.db
          .prepare(
            'SELECT payload_json as payloadJson FROM events WHERE run_id = ? ORDER BY seq ASC',
          )
          .all(lastRun.runId) as Array<{ payloadJson: string }>;

        let text = '';
        for (const row of rows) {
          try {
            const payload = JSON.parse(row.payloadJson);
            const update = payload?.update;
            if (update?.sessionUpdate !== 'agent_message_chunk') continue;
            text += update?.content?.text ?? '';
          } catch {
            // ignore malformed rows
          }
        }

        if (!text.trim()) {
          const fallback =
            lastRun.error ? `Last run error: ${lastRun.error}` : lastRun.stopReason;
          await sink.sendText(fallback ? String(fallback) : '(no output)');
          return true;
        }

        await sink.sendText(text);
        return true;
      }

      case '/replay': {
        const binding = getBinding(this.db, key);
        if (!binding) {
          await sink.sendText('No session binding. Send a message first.');
          return true;
        }

        const bindingKey = bindingKeyFromConversationKey(key);

        let runId = parts[1] ?? '';
        if (!runId) {
          const last = this.db
            .prepare(
              'SELECT run_id as runId FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1',
            )
            .get(binding.sessionKey) as { runId: string } | undefined;

          runId = last?.runId ?? '';
        }

        if (!runId) {
          await sink.sendText('No runs for this session yet.');
          return true;
        }

        const rows = this.db
          .prepare(
            'SELECT seq, method, payload_json as payloadJson FROM events WHERE run_id = ? ORDER BY seq ASC',
          )
          .all(runId) as Array<{ seq: number; method: string; payloadJson: string }>;

        let sent = false;
        let maxSeq = 0;

        for (const row of rows) {
          maxSeq = Math.max(maxSeq, row.seq);
          if (row.method !== 'session/update') continue;

          try {
            const payload = JSON.parse(row.payloadJson);
            const delta = renderSessionUpdateDelta(payload?.update);
            if (!delta) continue;
            await sink.sendText(delta);
            sent = true;
          } catch {
            // ignore malformed rows
          }
        }

        if (!sent) {
          await sink.sendText('(no replayable output)');
        }

        await sink.flush?.();

        const state = sink.getDeliveryState?.();
        if (state) {
          upsertDeliveryCheckpoint(this.db, {
            bindingKey,
            runId,
            lastSeq: maxSeq,
            messageId: state.messageId,
            text: state.text,
          });
        }

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

    let contextText = '';
    if (
      this.config.contextReplayEnabled &&
      this.config.contextReplayRuns > 0 &&
      !rt.hasSessionId()
    ) {
      contextText = buildReplayContextFromRecentRuns(this.db, {
        sessionKey,
        excludeRunId: runId,
        maxRuns: this.config.contextReplayRuns,
        maxChars: this.config.contextReplayMaxChars,
      });
    }

    try {
      const result = await rt.prompt({
        runId,
        promptText: text,
        sink,
        contextText,
      });

      finishRun(this.db, { runId, stopReason: result.stopReason });
    } catch (error: any) {
      finishRun(this.db, { runId, error: String(error?.message ?? error) });
      await sink.sendText(`Error: ${String(error?.message ?? error)}`);
    } finally {
      try {
        await sink.flush?.();
      } catch (error) {
        log.warn('sink flush error', error);
      }

      const state = sink.getDeliveryState?.();
      if (state) {
        const row = this.db
          .prepare('SELECT MAX(seq) as maxSeq FROM events WHERE run_id = ?')
          .get(runId) as { maxSeq: number | null } | undefined;

        upsertDeliveryCheckpoint(this.db, {
          bindingKey,
          runId,
          lastSeq: row?.maxSeq ?? 0,
          messageId: state.messageId,
          text: state.text,
        });
      }
    }
  }
}

function renderSessionUpdateDelta(update: any): string {
  if (!update || typeof update !== 'object') return '';

  if (update.sessionUpdate === 'agent_message_chunk') {
    return update?.content?.text ?? '';
  }

  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    return `\n[tool] ${update?.title ?? update?.toolCallId ?? 'tool_call'}`;
  }

  if (update.sessionUpdate === 'plan') {
    return '\n[plan]\n';
  }

  return '';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}
