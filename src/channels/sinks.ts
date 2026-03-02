import type { OutboundSink } from '../gateway/router.js';
import type { Platform } from '../gateway/sessionStore.js';
import type { DiscordController } from './discord.js';
import type { TelegramController } from './telegram.js';

export type SinkFactory = (
  platform: Platform,
  chatId: string,
  threadId: string | null,
) => OutboundSink;

export function createSinkFactory(params: {
  discord: DiscordController | null;
  telegram: TelegramController | null;
}): SinkFactory {
  return (platform, chatId, threadId) => {
    switch (platform) {
      case 'discord': {
        if (!params.discord) throw new Error('Discord sink not available');
        // discord createSink is async; scheduler will call sync factory.
        // For now, use a fire-and-forget bufferless sink.
        // TODO: refactor router/scheduler to accept async sink.
        throw new Error('Discord sink factory requires async createSink');
      }

      case 'telegram': {
        if (!params.telegram) throw new Error('Telegram sink not available');
        return params.telegram.createSink(chatId, threadId);
      }

      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  };
}
