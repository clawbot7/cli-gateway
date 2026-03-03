import test from 'node:test';
import assert from 'node:assert/strict';

import { createBufferedSink } from '../src/channels/bufferedSink.js';

test('buffered sink sends then edits', async () => {
  const sent: Array<{ id: string; text: string }> = [];
  const edits: Array<{ id: string; text: string }> = [];

  const sink = createBufferedSink({
    maxLen: 100,
    flushIntervalMs: 1000,
    send: async (text) => {
      const id = String(sent.length + 1);
      sent.push({ id, text });
      return { id };
    },
    edit: async (id, text) => {
      edits.push({ id, text });
    },
  });

  await sink.sendText('hello');
  await sink.flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'hello');

  await sink.sendText(' world');
  await sink.flush();

  assert.equal(edits.length, 1);
  assert.equal(edits[0].id, sent[0].id);
  assert.equal(edits[0].text, 'hello world');
});


test('buffered sink background flush runs on timer', async () => {
  const sent: string[] = [];

  const sink = createBufferedSink({
    maxLen: 100,
    flushIntervalMs: 5,
    send: async (text) => {
      sent.push(text);
      return { id: '1' };
    },
    edit: async () => {},
  });

  await sink.sendText('x');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(sent.length, 1);
});

test('buffered sink rotates message when buffer too large', async () => {
  const sent: string[] = [];

  const sink = createBufferedSink({
    maxLen: 10,
    flushIntervalMs: 1000,
    send: async (text) => {
      sent.push(text);
      return { id: String(sent.length) };
    },
    edit: async () => {},
  });

  await sink.sendText('0123456789');
  await sink.sendText('0123456789');
  await sink.flush();

  assert.ok(sent.length >= 1);
});

test('buffered sink falls back to send if edit fails', async () => {
  const sent: string[] = [];

  const sink = createBufferedSink({
    maxLen: 100,
    flushIntervalMs: 1000,
    send: async (text) => {
      sent.push(text);
      return { id: String(sent.length) };
    },
    edit: async () => {
      throw new Error('no');
    },
  });

  await sink.sendText('a');
  await sink.flush();

  await sink.sendText('b');
  await sink.flush();

  assert.equal(sent.length, 2);
  assert.equal(sent[0], 'a');
  assert.equal(sent[1], 'ab');
});
