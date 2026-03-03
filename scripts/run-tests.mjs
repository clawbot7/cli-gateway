import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const testDir = path.join(projectRoot, 'test');
const files = listTestFiles(testDir);

if (files.length === 0) {
  console.error('No test files found under test/.');
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  },
);

process.exit(res.status ?? 1);

function listTestFiles(dir) {
  /** @type {string[]} */
  const out = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTestFiles(full));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }

  // Deterministic order.
  out.sort();
  return out;
}
