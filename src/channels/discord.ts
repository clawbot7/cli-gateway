import {
  Client,
  GatewayIntentBits,
  Partials,
  type TextBasedChannel,
} from 'discord.js';

import type { GatewayRouter, OutboundSink } from '../gateway/router.js';
import type { AppConfig } from '../config.js';
import { log } from '../logging.js';
import type { ConversationKey } from '../gateway/sessionStore.js';
import { createDiscordSink } from './discordSink.js';

export type DiscordController = {
  createSink: (
    channelId: string,
    userId: string,
  ) => Promise<OutboundSink & { flush: () => Promise<void> }>;
};

/* c8 ignore start */
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

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton()) return;

      const id = interaction.customId;
      if (!id.startsWith('acpperm:')) return;

      const parts = id.split(':');
      const sessionKey = parts[1] ?? '';
      const requestId = parts[2] ?? '';
      const decision = parts[3] ?? '';

      if (!sessionKey || !requestId || (decision !== 'allow' && decision !== 'deny')) {
        return;
      }

      const res = await router.handlePermissionUi({
        platform: 'discord',
        sessionKey,
        requestId,
        decision,
        actorUserId: interaction.user.id,
      });

      if (!res.ok) {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: res.message, ephemeral: true });
          return;
        }
        await interaction.reply({ content: res.message, ephemeral: true });
        return;
      }

      await interaction.update({ content: res.message, components: [] });
    } catch (error) {
      log.error('Discord interaction handler error', error);
    }
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
      const sink = createDiscordSink(channel, message.author.id);

      await router.handleUserMessage(key, text, sink);
    } catch (error) {
      log.error('Discord message handler error', error);
    }
  });

  await client.login(config.discordToken);

  return {
    createSink: async (channelId: string, userId: string) => {
      const channel = (await client.channels.fetch(
        channelId,
      )) as TextBasedChannel | null;
      if (!channel) throw new Error(`Discord channel not found: ${channelId}`);
      return createDiscordSink(channel, userId);
    },
  };
}
/* c8 ignore stop */
