import fs from 'node:fs';
import path from 'node:path';

import 'dotenv/config';

import { loadConfig } from './config.js';
import { log } from './logging.js';
import { openDb } from './db/db.js';
import { migrate } from './db/migrations.js';
import { GatewayRouter } from './gateway/router.js';
import { startDiscord, type DiscordController } from './channels/discord.js';
import { startTelegram, type TelegramController } from './channels/telegram.js';
import { startScheduler } from './scheduler/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();

  fs.mkdirSync(config.workspaceRoot, { recursive: true });

  const db = openDb(config.dbPath);
  migrate(db);

  let scheduler: ReturnType<typeof startScheduler> | null = null;

  let discord: DiscordController | null = null;
  let telegram: TelegramController | null = null;

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

  if (config.schedulerEnabled) {
    scheduler = startScheduler({
      db,
      router,
      sinkFactory: async (platform, chatId, threadId) => {
        if (platform === 'discord') {
          if (!discord) throw new Error('Discord disabled');
          const sink = await discord.createSink(chatId);
          return sink;
        }

        if (platform === 'telegram') {
          if (!telegram) throw new Error('Telegram disabled');
          return telegram.createSink(chatId, threadId);
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
