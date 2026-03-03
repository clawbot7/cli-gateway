import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configFilePath,
  loadConfig,
  resolveGatewayHomeDir,
} from '../src/config.js';

test('loadConfig reads ~/.cli-gateway/config.json (via CLI_GATEWAY_HOME)', () => {
  const prev = { ...process.env };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-gateway-home-'));

  try {
    process.env.CLI_GATEWAY_HOME = tmp;

    const file = configFilePath(resolveGatewayHomeDir());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          acpAgentCommand: 'node',
          acpAgentArgs: ['-v'],
          workspaceRoot: '/tmp/cli-gateway-test',
          dbPath: 'data/test.db',
          schedulerEnabled: false,
          runtimeIdleTtlSeconds: 60,
          maxBindingRuntimes: 5,
          uiDefaultMode: 'summary',
          uiJsonMaxChars: 500,
          contextReplayEnabled: true,
          contextReplayRuns: 1,
          contextReplayMaxChars: 500,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    const cfg = loadConfig();

    assert.equal(cfg.acpAgentCommand, 'node');
    assert.deepEqual(cfg.acpAgentArgs, ['-v']);
    assert.equal(cfg.workspaceRoot, '/tmp/cli-gateway-test');
    assert.equal(cfg.dbPath, path.join(tmp, 'data/test.db'));

    assert.equal(cfg.schedulerEnabled, false);
    assert.equal(cfg.runtimeIdleTtlSeconds, 60);
    assert.equal(cfg.maxBindingRuntimes, 5);

    assert.equal(cfg.uiDefaultMode, 'summary');
    assert.equal(cfg.uiJsonMaxChars, 500);

    assert.equal(cfg.contextReplayEnabled, true);
    assert.equal(cfg.contextReplayRuns, 1);
  } finally {
    process.env = prev;
  }
});

test('loadConfig bootstraps a default config file when missing', () => {
  const prev = { ...process.env };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-gateway-home-'));

  try {
    process.env.CLI_GATEWAY_HOME = tmp;

    const cfg = loadConfig();

    const file = configFilePath(resolveGatewayHomeDir());
    assert.ok(fs.existsSync(file));

    assert.equal(cfg.uiDefaultMode, 'verbose');
    assert.ok(path.isAbsolute(cfg.workspaceRoot));
    assert.ok(path.isAbsolute(cfg.dbPath));
  } finally {
    process.env = prev;
  }
});
