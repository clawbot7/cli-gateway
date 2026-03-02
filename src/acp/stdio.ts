import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { log } from '../logging.js';
import type { JsonRpcMessage } from './jsonrpc.js';

export type StdioProcess = {
  write: (message: JsonRpcMessage) => void;
  onMessage: (cb: (message: JsonRpcMessage) => void) => void;
  onStderr: (cb: (line: string) => void) => void;
  kill: () => void;
};

export function spawnAcpAgent(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): StdioProcess {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...env,
    },
  });

  const stdoutRl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  const stderrRl = readline.createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  });

  const messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  const stderrHandlers: Array<(line: string) => void> = [];

  stdoutRl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcMessage;
      messageHandlers.forEach((h) => h(msg));
    } catch (error) {
      log.error('ACP stdout non-JSON line (fatal):', line);
      log.error(error);
      child.kill('SIGKILL');
    }
  });

  stderrRl.on('line', (line) => {
    stderrHandlers.forEach((h) => h(line));
  });

  child.on('exit', (code, signal) => {
    log.warn('ACP agent exited', { code, signal });
  });

  function write(message: JsonRpcMessage): void {
    const payload = JSON.stringify(message);
    if (payload.includes('\n')) {
      // JSON itself must be newline-delimited; embedded newlines here are a bug.
      throw new Error('ACP message serialization produced newline');
    }
    child.stdin.write(payload + '\n');
  }

  return {
    write,
    onMessage: (cb) => {
      messageHandlers.push(cb);
    },
    onStderr: (cb) => {
      stderrHandlers.push(cb);
    },
    kill: () => {
      child.kill('SIGTERM');
    },
  };
}
