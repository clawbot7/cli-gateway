import path from 'node:path';

import { acquireProcessLock } from './runtime/lock.js';
import { resolveGatewayHomeDir } from './config.js';

import { loadConfig } from './config.js';
import { log } from './logging.js';
import { openDb } from './db/db.js';
import { migrate } from './db/migrations.js';
import { GatewayRouter } from './gateway/router.js';
import { startDiscord, type DiscordController } from './channels/discord.js';
import { startTelegram, type TelegramController } from './channels/telegram.js';
import { startFeishu, type FeishuController } from './channels/feishu.js';
import { startScheduler } from './scheduler/scheduler.js';

async function main(): Promise<void> {
  const gatewayHome = resolveGatewayHomeDir();
  const lock = acquireProcessLock(path.join(gatewayHome, 'gateway.lock'));

  const cleanup = () => {
    lock.release();
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  const config = await loadConfig({ interactiveBootstrap: true });

  const db = openDb(config.dbPath);
  migrate(db);

  let scheduler: ReturnType<typeof startScheduler> | null = null;

  let discord: DiscordController | null = null;
  let telegram: TelegramController | null = null;
  let feishu: FeishuController | null = null;

  const router = new GatewayRouter({
    db,
    config,
    onJobsChanged: () => {
      scheduler?.reload();
    },
  });

  await router.start();

  discord = await startDiscord(router, config);
  telegram = await startTelegram(router, config);
  feishu = await startFeishu(router, config);

  if (config.schedulerEnabled) {
    scheduler = startScheduler({
      db,
      router,
      sinkFactory: async (platform, chatId, threadId, userId) => {
        if (platform === 'discord') {
          if (!discord) throw new Error('Discord disabled');
          const sink = await discord.createSink(chatId, userId);
          return sink;
        }

        if (platform === 'telegram') {
          if (!telegram) throw new Error('Telegram disabled');
          return telegram.createSink(chatId, threadId, userId);
        }

        if (platform === 'feishu') {
          if (!feishu) throw new Error('Feishu disabled');
          return feishu.createSink(chatId, userId);
        }

        throw new Error(`Unsupported platform: ${platform}`);
      },
    });
  }

  log.info('cli-gateway started', {
    workspaceRoot: config.workspaceRoot,
    dbPath: path.resolve(config.dbPath),
    schedulerEnabled: config.schedulerEnabled,
  });

  const shutdown = () => {
    log.warn('Shutting down...');
    scheduler?.stop();
    router.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
