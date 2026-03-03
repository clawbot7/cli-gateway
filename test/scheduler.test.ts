import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTemplate } from '../src/scheduler/template.js';

test('renderTemplate replaces vars', () => {
  const out = renderTemplate('a {{date}} b {{now_iso}}');
  assert.ok(out.includes('a '));
  assert.ok(out.includes(' b '));
  assert.ok(!out.includes('{{date}}'));
  assert.ok(!out.includes('{{now_iso}}'));
});
