import cron from 'node-cron';

import type { Db } from '../db/db.js';
import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { Platform } from '../gateway/sessionStore.js';
import { log } from '../logging.js';

export type Scheduler = {
  reload: () => void;
  stop: () => void;
};

export function startScheduler(params: {
  db: Db;
  router: GatewayRouter;
  sinkFactory: (
    platform: Platform,
    chatId: string,
    threadId: string | null,
  ) => Promise<OutboundSink & { flush?: () => Promise<void> }>;
}): Scheduler {
  let tasks: cron.ScheduledTask[] = [];

  function stopAll(): void {
    tasks.forEach((t) => t.stop());
    tasks = [];
  }

  function load(): void {
    stopAll();

    const jobs = params.db
      .prepare(
        `
        SELECT j.job_id as jobId,
               j.binding_key as bindingKey,
               j.cron_expr as cronExpr,
               j.prompt_template as promptTemplate
          FROM jobs j
         WHERE j.enabled = 1
        `,
      )
      .all() as Array<{
      jobId: string;
      bindingKey: string;
      cronExpr: string;
      promptTemplate: string;
    }>;

    for (const job of jobs) {
      const binding = params.db
        .prepare(
          'SELECT platform, chat_id as chatId, thread_id as threadId, user_id as userId FROM bindings WHERE binding_key = ?',
        )
        .get(job.bindingKey) as
        | {
            platform: Platform;
            chatId: string;
            threadId: string | null;
            userId: string;
          }
        | undefined;

      if (!binding) {
        log.warn('Scheduler: missing binding for job', job.jobId);
        continue;
      }

      if (!cron.validate(job.cronExpr)) {
        log.warn(
          'Scheduler: invalid cron expr',
          job.cronExpr,
          'job',
          job.jobId,
        );
        continue;
      }

      const task = cron.schedule(job.cronExpr, async () => {
        const rendered = renderTemplate(job.promptTemplate);
        const sink = await params.sinkFactory(
          binding.platform,
          binding.chatId,
          binding.threadId,
        );

        await params.router.handleUserMessage(
          {
            platform: binding.platform,
            chatId: binding.chatId,
            threadId: binding.threadId,
            userId: binding.userId,
          },
          rendered,
          sink,
        );

        await sink.flush?.();
      });

      tasks.push(task);
      log.info('Scheduler job loaded', {
        jobId: job.jobId,
        cron: job.cronExpr,
      });
    }
  }

  load();

  return {
    reload: () => {
      load();
    },
    stop: () => {
      stopAll();
    },
  };
}

function renderTemplate(template: string): string {
  const now = new Date();
  return template
    .replaceAll('{{now_iso}}', now.toISOString())
    .replaceAll('{{date}}', now.toISOString().slice(0, 10));
}
