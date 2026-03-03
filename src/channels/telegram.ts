import { Bot } from 'grammy';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';
import { createTelegramSink } from './telegramSink.js';
import { setChatMenuButton, setMessageReaction } from './telegramApi.js';

export type TelegramController = {
  createSink: (
    chatId: string,
    threadId: string | null,
    userId: string,
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

  const tgCommands = [
    { command: 'help', description: 'Show commands' },
    { command: 'ui', description: 'Set UI mode (verbose/summary)' },
    { command: 'workspace', description: 'Show/set workspace' },
    { command: 'cron', description: 'Manage scheduler jobs' },
    { command: 'new', description: 'Reset conversation session' },
    { command: 'last', description: 'Show last run output' },
    { command: 'replay', description: 'Replay a run output' },
  ];

  // Best-effort: register commands.
  void bot.api
    .setMyCommands(tgCommands)
    .catch((err) => log.warn('Telegram setMyCommands(default) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_private_chats' } })
    .catch((err) => log.warn('Telegram setMyCommands(private) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_group_chats' } })
    .catch((err) => log.warn('Telegram setMyCommands(group) error', err));
  void bot.api
    .setMyCommands(tgCommands, { scope: { type: 'all_chat_administrators' } })
    .catch((err) => log.warn('Telegram setMyCommands(admins) error', err));

  // Force Telegram UI to show the command menu button.
  void setChatMenuButton(config.telegramToken, {}, fetch).catch((err) =>
    log.warn('Telegram setChatMenuButton(default) error', err),
  );

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data ?? '';

    // Always answer quickly so the client doesn't spin.
    try {
      await ctx.answerCallbackQuery({ text: 'Processing...', show_alert: false });
    } catch {
      // ignore
    }

    if (!data.startsWith('acpperm:')) return;

    try {
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

      const msg = ctx.callbackQuery.message;
      if (msg) {
        const emoji = decision === 'allow' ? '👍' : '👎';
        void setMessageReaction(
          config.telegramToken,
          {
            chatId: msg.chat.id,
            messageId: msg.message_id,
            emoji,
            isBig: false,
          },
          fetch,
        ).catch(() => {
          // ignore
        });

        if (res.ok) {
          try {
            await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, {
              reply_markup: { inline_keyboard: [] },
            });
          } catch {
            // ignore
          }
        }
      }

      // Visible confirmation.
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
      const text = ctx.message.text?.trim() ?? '';
      if (!text) return;

      // Per-chat: ensure menu button is commands.
      void setChatMenuButton(config.telegramToken, { chatId: ctx.chat.id }, fetch).catch(
        () => {
          // ignore
        },
      );

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

      // /start should show help, not fall through to the agent.
      const normalizedText = text.startsWith('/start') ? '/help' : text;

      const sink = normalizedText.startsWith('/')
        ? createTelegramCommandSink(bot, ctx.chat.id, threadId ? Number(threadId) : null)
        : createTelegramSink(
            bot,
            ctx.chat.id,
            threadId ? Number(threadId) : null,
            userId,
          );

      // Emoji reaction: processing.
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

      // IMPORTANT: do not await; grammY processes updates sequentially.
      const p = router.handleUserMessage(key, normalizedText, sink);

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

  // Ensure webhook is disabled and clear backlog.
  void bot.api
    .deleteWebhook({ drop_pending_updates: true })
    .catch((err) => log.warn('Telegram deleteWebhook error', err));

  try {
    bot.start({
      allowed_updates: ['message', 'callback_query'],
    });
    log.info('Telegram bot started (long polling)');
  } catch (err) {
    log.error('Telegram bot start error', err);
  }

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

function createTelegramCommandSink(
  bot: Bot,
  chatId: number,
  threadId: number | null,
): OutboundSink & { flush: () => Promise<void> } {
  let text = '';

  return {
    sendText: async (delta: string) => {
      text += delta;
    },
    flush: async () => {
      const out = text.trim();
      text = '';
      if (!out) return;
      await bot.api.sendMessage(chatId, out, {
        message_thread_id: threadId ?? undefined,
      });
    },
    sendUi: async (event) => {
      const header = `[${event.kind}] ${event.title}`;
      const body = event.detail && event.mode === 'verbose' ? `\n\n${event.detail}` : '';
      await bot.api.sendMessage(chatId, `${header}${body}`, {
        message_thread_id: threadId ?? undefined,
      });
    },
  };
}
