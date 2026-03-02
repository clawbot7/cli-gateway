import {
  Client,
  GatewayIntentBits,
  Partials,
  type TextBasedChannel,
  type SendableChannels,
} from 'discord.js';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';
import { createBufferedSink } from './bufferedSink.js';

export type DiscordController = {
  createSink: (
    channelId: string,
  ) => Promise<OutboundSink & { flush: () => Promise<void> }>;
};

export async function startDiscord(
  router: GatewayRouter,
  config: AppConfig,
): Promise<DiscordController | null> {
  if (!config.discordToken) {
    log.info('Discord disabled: missing DISCORD_TOKEN');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on('ready', () => {
    log.info('Discord connected');
  });

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;

      if (
        config.discordAllowChannelId &&
        message.channelId !== config.discordAllowChannelId
      ) {
        return;
      }

      const text = message.content ?? '';
      if (!text.trim()) return;

      const key: ConversationKey = {
        platform: 'discord',
        chatId: message.channelId,
        threadId: null,
        userId: message.author.id,
      };

      const channel = message.channel as TextBasedChannel;
      const sink = createDiscordSink(channel);

      await router.handleUserMessage(key, text, sink);
      await sink.flush();
    } catch (error) {
      log.error('Discord message handler error', error);
    }
  });

  await client.login(config.discordToken);

  return {
    createSink: async (channelId: string) => {
      const channel = (await client.channels.fetch(
        channelId,
      )) as TextBasedChannel | null;
      if (!channel) throw new Error(`Discord channel not found: ${channelId}`);
      return createDiscordSink(channel);
    },
  };
}

function createDiscordSink(
  channel: TextBasedChannel,
): OutboundSink & { flush: () => Promise<void> } {
  const sendChannel = channel as unknown as SendableChannels;

  const buffered = createBufferedSink({
    maxLen: 1800,
    flushIntervalMs: 700,
    send: async (text) => {
      const msg = await sendChannel.send(text);
      return { id: msg.id };
    },
    edit: async (id, text) => {
      const msg = await sendChannel.messages.fetch(id);
      await msg.edit(text);
    },
  });

  return {
    sendText: buffered.sendText,
    flush: buffered.flush,
  };
}
