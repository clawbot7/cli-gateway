import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { openDb } from '../src/db/db.js';

test('openDb creates parent dir and sets pragmas', () => {
  const dbPath = '.data/test-open.db';
  try {
    fs.rmSync('.data', { recursive: true, force: true });
  } catch {
    // ignore
  }

  const db = openDb(dbPath);

  const fk = db.pragma('foreign_keys', { simple: true }) as number;
  assert.equal(fk, 1);

  db.close();
});
