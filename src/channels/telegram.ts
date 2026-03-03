import { Bot } from 'grammy';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';
import { createBufferedSink } from './bufferedSink.js';

export type TelegramController = {
  createSink: (
    chatId: string,
    threadId: string | null,
  ) => OutboundSink & { flush: () => Promise<void> };
};

export async function startTelegram(
  router: GatewayRouter,
  config: AppConfig,
): Promise<TelegramController | null> {
  if (!config.telegramToken) {
    log.info('Telegram disabled: missing TELEGRAM_TOKEN');
    return null;
  }

  const bot = new Bot(config.telegramToken);

  bot.on('message:text', async (ctx) => {
    try {
      const text = ctx.message.text;
      if (!text?.trim()) return;

      const threadId = ctx.message.message_thread_id
        ? String(ctx.message.message_thread_id)
        : null;

      const key: ConversationKey = {
        platform: 'telegram',
        chatId: String(ctx.chat.id),
        threadId,
        userId: String(ctx.from?.id ?? 'unknown'),
      };

      const sink = createTelegramSink(
        bot,
        ctx.chat.id,
        threadId ? Number(threadId) : null,
      );
      await router.handleUserMessage(key, text, sink);
    } catch (error) {
      log.error('Telegram message handler error', error);
    }
  });

  bot.catch((err) => {
    log.error('Telegram bot error', err);
  });

  await bot.start();

  return {
    createSink: (chatId, threadId) =>
      createTelegramSink(
        bot,
        Number(chatId),
        threadId ? Number(threadId) : null,
      ),
  };
}

function createTelegramSink(
  bot: Bot,
  chatId: number,
  threadId: number | null,
): OutboundSink & { flush: () => Promise<void> } {
  const buffered = createBufferedSink({
    maxLen: 3800,
    flushIntervalMs: 700,
    send: async (text) => {
      const msg = await bot.api.sendMessage(chatId, text, {
        message_thread_id: threadId ?? undefined,
      });
      return { id: String(msg.message_id) };
    },
    edit: async (id, text) => {
      // grammY typings currently don't expose message_thread_id for editMessageText.
      await bot.api.editMessageText(chatId, Number(id), text, {
        ...(threadId ? ({ message_thread_id: threadId } as any) : {}),
      });
    },
  });

  return {
    sendText: buffered.sendText,
    flush: buffered.flush,
    getDeliveryState: buffered.getState,
  };
}
