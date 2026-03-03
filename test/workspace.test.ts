import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWorkspacePath } from '../src/tools/workspace.js';

test('resolveWorkspacePath enforces absolute + within root', () => {
  assert.throws(() => resolveWorkspacePath('/root/ws', 'relative.txt'));

  assert.equal(resolveWorkspacePath('/root/ws', '/root/ws'), '/root/ws');
  assert.equal(
    resolveWorkspacePath('/root/ws', '/root/ws/a/b.txt'),
    '/root/ws/a/b.txt',
  );

  assert.throws(() => resolveWorkspacePath('/root/ws', '/root/other.txt'));
  assert.throws(() => resolveWorkspacePath('/root/ws', '/root/ws/../x.txt'));
});
