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

const c8Bin = path.join(projectRoot, 'node_modules', 'c8', 'bin', 'c8.js');
if (!fs.existsSync(c8Bin)) {
  console.error('c8 is not installed. Run npm install.');
  process.exit(1);
}

const args = [
  c8Bin,
  '--all',
  '--check-coverage',
  '--lines',
  '90',
  '--functions',
  '90',
  '--statements',
  '90',
  '--reporter',
  'text',
  process.execPath,
  '--import',
  'tsx',
  '--test',
  ...files,
];

const res = spawnSync(process.execPath, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

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

  out.sort();
  return out;
}
