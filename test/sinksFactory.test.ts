import test from 'node:test';
import assert from 'node:assert/strict';

import { createSinkFactory } from '../src/channels/sinks.js';

test('createSinkFactory returns telegram sink', () => {
  const sinkFactory = createSinkFactory({
    discord: null,
    telegram: {
      createSink: (_chatId: string, _threadId: string | null, _userId: string) => ({
        sendText: async () => {},
      }),
    } as any,
  });

  const sink = sinkFactory('telegram', 'c', null, 'u');
  assert.equal(typeof sink.sendText, 'function');
});

test('createSinkFactory throws for unsupported/async discord sink', () => {
  const sinkFactory = createSinkFactory({
    discord: {} as any,
    telegram: null,
  });

  assert.throws(() => sinkFactory('discord', 'c', null, 'u'));
});
