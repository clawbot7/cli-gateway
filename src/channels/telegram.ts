import { Bot } from 'grammy';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';
import { createTelegramSink } from './telegramSink.js';
import { setMessageReaction } from './telegramApi.js';

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

  void bot.api
    .setMyCommands([
      { command: 'help', description: 'Show commands' },
      { command: 'ui', description: 'Set UI mode (verbose/summary)' },
      { command: 'workspace', description: 'Show/set workspace' },
      { command: 'cron', description: 'Manage scheduler jobs' },
      { command: 'new', description: 'Reset conversation session' },
      { command: 'last', description: 'Show last run output' },
      { command: 'replay', description: 'Replay a run output' },
    ])
    .catch((err) => log.warn('Telegram setMyCommands error', err));

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data ?? '';

    // Always answer quickly so the Telegram client doesn't hang.
    try {
      await ctx.answerCallbackQuery({ text: 'Processing...', show_alert: false });
    } catch {
      // ignore
    }

    try {
      if (!data.startsWith('acpperm:')) return;

      const parts = data.split(':');
      const sessionKey = parts[1] ?? '';
      const requestId = parts[2] ?? '';
      const decision = parts[3] ?? '';

      if (
        !sessionKey ||
        !requestId ||
        (decision !== 'allow' && decision !== 'deny')
      ) {
        return;
      }

      const actorUserId = String(ctx.from?.id ?? '');

      log.info('telegram permission click', {
        actorUserId,
        sessionKey,
        requestId,
        decision,
      });

      const res = await router.handlePermissionUi({
        platform: 'telegram',
        sessionKey,
        requestId,
        decision,
        actorUserId,
      });

      log.info('telegram permission result', {
        ok: res.ok,
        message: res.message,
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

          // Emoji reaction as a quick confirmation.
          const emoji = decision === 'allow' ? '👍' : '👎';
          void setMessageReaction(config.telegramToken, {
            chatId: msg.chat.id,
            messageId: msg.message_id,
            emoji,
          }).catch(() => {
            // ignore
          });
        }
      }

      // Post a visible confirmation message since callback toasts can be flaky.
      try {
        await ctx.reply(res.message);
      } catch (error) {
        log.error('Telegram permission reply error', error);
      }
    } catch (error) {
      log.error('Telegram callback handler error', error);
      try {
        await ctx.reply('Internal error.');
      } catch {
        // ignore
      }
    }
  });

  bot.on('message:text', async (ctx) => {
    try {
      const text = ctx.message.text;
      if (!text?.trim()) return;

      // Emoji reaction to acknowledge receipt.
      void setMessageReaction(config.telegramToken, {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        emoji: '👀',
      }).catch(() => {
        // ignore
      });

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
        config.telegramToken,
        ctx.chat.id,
        threadId ? Number(threadId) : null,
        userId,
      );

      // Do not await: grammY processes updates sequentially.
      // Awaiting here deadlocks permission flow (callback_query can't be handled).
      // Emoji reaction: acknowledge that we're processing.
      void setMessageReaction(
        config.telegramToken,
        {
          chatId: ctx.chat.id,
          messageId: ctx.message.message_id,
          emoji: '🤔',
          isBig: false,
        },
        fetch,
      ).catch(() => {
        // ignore
      });

      const p = router.handleUserMessage(key, text, sink);

      // Emoji reaction: final status.
      void p
        .then(async () => {
          await setMessageReaction(
            config.telegramToken,
            {
              chatId: ctx.chat.id,
              messageId: ctx.message.message_id,
              emoji: '🕊',
              isBig: false,
            },
            fetch,
          );
        })
        .catch(async (error) => {
          log.error('Telegram router handler error', error);
          try {
            await setMessageReaction(
              config.telegramToken,
              {
                chatId: ctx.chat.id,
                messageId: ctx.message.message_id,
                emoji: '😢',
                isBig: false,
              },
              fetch,
            );
          } catch {
            // ignore
          }
        });
    } catch (error) {
      log.error('Telegram message handler error', error);
    }
  });

  bot.catch((err) => {
    log.error('Telegram bot error', err);
  });

  // Ensure webhook is disabled and optionally clear backlog.
  void bot.api
    .deleteWebhook({ drop_pending_updates: true })
    .catch((err) => log.warn('Telegram deleteWebhook error', err));

  void bot
    .start({
      allowed_updates: ['message', 'callback_query'],
    })
    .catch((err) => {
      log.error('Telegram bot start error', err);
    });

  log.info('Telegram bot started (long polling)', {
    allowedUpdates: ['message', 'callback_query'],
    dropPendingUpdates: true,
  });

  return {
    createSink: (chatId, threadId, userId) =>
      createTelegramSink(
        bot,
        config.telegramToken,
        Number(chatId),
        threadId ? Number(threadId) : null,
        userId,
      ),
  };
}
/* c8 ignore stop */
