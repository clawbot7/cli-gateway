import test from 'node:test';
import assert from 'node:assert/strict';

import { createDiscordSink } from '../src/channels/discordSink.js';

function createFakeChannel() {
  const sent: any[] = [];
  const edits: any[] = [];

  const channel = {
    send: async (payload: any) => {
      sent.push(payload);
      return { id: String(sent.length) };
    },
    messages: {
      fetch: async (id: string) => ({
        edit: async (text: string) => {
          edits.push({ id, text });
        },
      }),
    },
  } as any;

  return { channel, sent, edits };
}

test('discord sink renders permission as embed + buttons', async () => {
  const { channel, sent } = createFakeChannel();

  const sink = createDiscordSink(channel, 'user1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'fs/read_text_file',
    toolKind: 'read',
  });

  const msg = sent.at(-1);
  assert.ok(msg.embeds?.length);
  assert.ok(msg.components?.length);
  assert.ok(String(msg.content).includes('<@user1>'));
});

test('discord sink renders UI events as embed', async () => {
  const { channel, sent } = createFakeChannel();

  const sink = createDiscordSink(channel, 'user1');

  await sink.sendUi!({
    kind: 'tool',
    mode: 'verbose',
    title: 'fs/read_text_file',
    detail: '{"a":1}',
  });

  const msg = sent.at(-1);
  assert.ok(msg.embeds?.length);
});

test('discord sink supports buffered streaming', async () => {
  const { channel, sent, edits } = createFakeChannel();

  const sink = createDiscordSink(channel, 'user1');
  await sink.sendText('a');
  await sink.flush();

  await sink.sendText('b');
  await sink.flush();

  assert.ok(sent.length >= 1);
  assert.ok(edits.length >= 1);
});
