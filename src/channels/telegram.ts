import { Bot } from 'grammy';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';
import { createTelegramSink } from './telegramSink.js';

export type TelegramController = {
  createSink: (
    chatId: string,
    threadId: string | null,
    userId: string,
  ) => OutboundSink & { flush: () => Promise<void> };
};

/* c8 ignore start */
export async function startTelegram(
  router: GatewayRouter,
  config: AppConfig,
): Promise<TelegramController | null> {
  if (!config.telegramToken) {
    log.info('Telegram disabled: missing TELEGRAM_TOKEN');
    return null;
  }

  const bot = new Bot(config.telegramToken);

  bot.on('callback_query:data', async (ctx) => {
    try {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith('acpperm:')) return;

      const parts = data.split(':');
      const sessionKey = parts[1] ?? '';
      const requestId = parts[2] ?? '';
      const decision = parts[3] ?? '';

      if (!sessionKey || !requestId || (decision !== 'allow' && decision !== 'deny')) {
        return;
      }

      const actorUserId = String(ctx.from?.id ?? '');

      const res = await router.handlePermissionUi({
        platform: 'telegram',
        sessionKey,
        requestId,
        decision,
        actorUserId,
      });

      await ctx.answerCallbackQuery({
        text: res.message,
        show_alert: !res.ok,
      });

      if (res.ok) {
        const msg = ctx.callbackQuery.message;
        if (msg) {
          try {
            await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, {
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            // ignore if message is not editable
          }
        }
      }
    } catch (error) {
      log.error('Telegram callback handler error', error);
    }
  });

  bot.on('message:text', async (ctx) => {
    try {
      const text = ctx.message.text;
      if (!text?.trim()) return;

      const threadId = ctx.message.message_thread_id
        ? String(ctx.message.message_thread_id)
        : null;

      const userId = String(ctx.from?.id ?? 'unknown');

      const key: ConversationKey = {
        platform: 'telegram',
        chatId: String(ctx.chat.id),
        threadId,
        userId,
      };

      const sink = createTelegramSink(
        bot,
        ctx.chat.id,
        threadId ? Number(threadId) : null,
        userId,
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
    createSink: (chatId, threadId, userId) =>
      createTelegramSink(
        bot,
        Number(chatId),
        threadId ? Number(threadId) : null,
        userId,
      ),
  };
}
/* c8 ignore stop */
