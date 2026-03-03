import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelegramSink } from '../src/channels/telegramSink.js';

function createFakeBot() {
  const calls: any[] = [];

  const bot = {
    api: {
      sendMessage: async (...args: any[]) => {
        calls.push({ method: 'sendMessage', args });
        return { message_id: 1 };
      },
      editMessageText: async (...args: any[]) => {
        calls.push({ method: 'editMessageText', args });
      },
    },
  } as any;

  return { bot, calls };
}

test('telegram sink renders permission with inline keyboard + HTML', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 1, null, 'u1');

  await sink.requestPermission!({
    uiMode: 'verbose',
    sessionKey: 's',
    requestId: 'r',
    toolTitle: 'fs/read_text_file',
    toolKind: 'read',
  });

  const call = calls.find((c) => c.method === 'sendMessage');
  assert.ok(call);
  assert.equal(call.args[0], 1);
  assert.equal(call.args[2].parse_mode, 'HTML');
  assert.ok(call.args[2].reply_markup);
});

test('telegram sink renders UI events with HTML', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 1, null, 'u1');
  await sink.sendUi!({
    kind: 'plan',
    mode: 'verbose',
    title: 'Plan updated',
    detail: '{"x":1}',
  });

  const call = calls.at(-1);
  assert.equal(call.method, 'sendMessage');
  assert.equal(call.args[2].parse_mode, 'HTML');
});

test('telegram sink supports buffered streaming', async () => {
  const { bot, calls } = createFakeBot();

  const sink = createTelegramSink(bot, 1, null, 'u1');
  await sink.sendText('a');
  await sink.flush();

  await sink.sendText('b');
  await sink.flush();

  const sendCalls = calls.filter((c) => c.method === 'sendMessage');
  assert.ok(sendCalls.length >= 1);
});
