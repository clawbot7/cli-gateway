import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type TextBasedChannel,
  type SendableChannels,
} from 'discord.js';

import type { OutboundSink } from '../gateway/router.js';
import { createBufferedSink } from './bufferedSink.js';

export function createDiscordSink(
  channel: TextBasedChannel,
  userId: string,
): OutboundSink & { flush: () => Promise<void> } {
  const sendChannel = channel as unknown as SendableChannels;
  const toolUiMessageById = new Map<string, string>();

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
    breakTextStream: buffered.breakMessage,
    flush: buffered.flush,
    getDeliveryState: buffered.getState,
    requestPermission: async (req) => {
      const allowId = `acpperm:${req.sessionKey}:${req.requestId}:allow`;
      const denyId = `acpperm:${req.sessionKey}:${req.requestId}:deny`;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(allowId)
          .setLabel('Allow')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(denyId)
          .setLabel('Deny')
          .setStyle(ButtonStyle.Danger),
      );

      const embed = new EmbedBuilder()
        .setTitle('Permission required')
        .setColor(0xffcc00)
        .addFields(
          { name: 'Tool', value: truncate(req.toolTitle, 256) },
          { name: 'Kind', value: req.toolKind ?? 'unknown' },
        );

      if (req.uiMode === 'verbose') {
        embed.addFields(
          { name: 'Session', value: truncate(req.sessionKey, 512) },
          { name: 'Request', value: truncate(req.requestId, 256) },
        );
      }

      const msg = await sendChannel.send({
        content: `<@${userId}> Please approve this tool call.`,
        embeds: [embed],
        components: [row],
      });

      await addDiscordPermissionReactions(msg);
    },
    sendUi: async (event) => {
      const title = truncate(`[${event.kind}] ${event.title}`, 256);
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(colorForKind(event.kind));

      if (event.detail && event.mode === 'verbose') {
        embed.setDescription(
          `\`\`\`json\n${truncate(event.detail, 3800)}\n\`\`\``,
        );
      }

      if (event.kind === 'tool' && event.toolCallId?.trim()) {
        const key = event.toolCallId.trim();
        const existingId = toolUiMessageById.get(key);
        if (existingId) {
          try {
            const existing = await sendChannel.messages.fetch(existingId);
            await existing.edit({ embeds: [embed] });
            return;
          } catch {
            // fall through and resend
          }
        }

        const msg = await sendChannel.send({ embeds: [embed] });
        toolUiMessageById.set(key, msg.id);
        return;
      }

      await sendChannel.send({ embeds: [embed] });
    },
  };
}

async function addDiscordPermissionReactions(message: unknown): Promise<void> {
  if (
    !message ||
    typeof message !== 'object' ||
    typeof (message as { react?: unknown }).react !== 'function'
  ) {
    return;
  }

  const react = (message as { react: (emoji: string) => Promise<unknown> }).react;
  try {
    await react('👍');
  } catch {
    // best effort
  }
  try {
    await react('👎');
  } catch {
    // best effort
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function colorForKind(kind: string): number {
  switch (kind) {
    case 'tool':
      return 0x0099ff;
    case 'plan':
      return 0x8a2be2;
    case 'task':
      return 0x00aa55;
    default:
      return 0x666666;
  }
}
