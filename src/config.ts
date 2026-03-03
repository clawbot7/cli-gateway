import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { z } from 'zod';

function resolveHomeDir(): string {
  return os.homedir();
}

export function resolveGatewayHomeDir(): string {
  const env = process.env.CLI_GATEWAY_HOME;
  if (env?.trim()) return expandPath(env.trim(), resolveHomeDir());
  return path.join(resolveHomeDir(), '.cli-gateway');
}

export function configFilePath(gatewayHome: string): string {
  return path.join(gatewayHome, 'config.json');
}

function expandPath(raw: string, homeDir: string): string {
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/')) return path.join(homeDir, raw.slice(2));
  return raw;
}

function resolvePathRelativeTo(
  raw: string,
  baseDir: string,
  homeDir: string,
): string {
  const expanded = expandPath(raw, homeDir);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(baseDir, expanded);
}

function createConfigSchema(defaults: {
  defaultWorkspaceRoot: string;
  defaultDbPath: string;
}): z.ZodType<any> {
  const absPath = z
    .string()
    .min(1)
    .refine((p) => path.isAbsolute(p), {
      message: 'must be an absolute path',
    });

  return z.object({
    discordToken: z.string().optional(),
    discordAllowChannelId: z.string().optional(),

    telegramToken: z.string().optional(),

    feishuAppId: z.string().optional(),
    feishuAppSecret: z.string().optional(),
    feishuVerificationToken: z.string().optional(),
    feishuListenPort: z.number().int().min(1).max(65535).default(3030),

    acpAgentCommand: z.string().min(1).default('npx'),
    acpAgentArgs: z
      .array(z.string())
      .default(['-y', '@zed-industries/codex-acp@latest']),

    // Default workspace is ~ (switchable per conversation via /workspace)
    workspaceRoot: absPath.default(defaults.defaultWorkspaceRoot),

    // Default DB path lives under ~/.cli-gateway
    dbPath: z.string().min(1).default(defaults.defaultDbPath),

    schedulerEnabled: z.boolean().default(true),

    runtimeIdleTtlSeconds: z.number().int().min(10).default(15 * 60),
    maxBindingRuntimes: z.number().int().min(1).max(200).default(30),

    uiDefaultMode: z.enum(['verbose', 'summary']).default('verbose'),
    uiJsonMaxChars: z.number().int().min(200).max(200_000).default(12_000),

    contextReplayEnabled: z.boolean().default(true),
    contextReplayRuns: z.number().int().min(0).max(50).default(8),
    contextReplayMaxChars: z.number().int().min(200).max(200_000).default(12_000),
  });
}

export type AppConfig = z.infer<ReturnType<typeof createConfigSchema>>;

export type LoadConfigOptions = {
  interactiveBootstrap?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const homeDir = resolveHomeDir();
  const gatewayHome = resolveGatewayHomeDir();

  fs.mkdirSync(gatewayHome, { recursive: true });

  const defaults = {
    defaultWorkspaceRoot: homeDir,
    defaultDbPath: path.join(gatewayHome, 'data', 'gateway.db'),
  };

  const schema = createConfigSchema(defaults);

  const file = configFilePath(gatewayHome);

  let raw: any;
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const shouldRunWizard =
      options.interactiveBootstrap === true &&
      isInteractiveTerminal(input, output);

    raw = shouldRunWizard
      ? await runFirstTimeSetup({
          defaults,
          file,
          input,
          output,
        })
      : createDefaultConfig(defaults);

    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  }

  // Normalize paths.
  if (typeof raw?.workspaceRoot === 'string') {
    raw.workspaceRoot = resolvePathRelativeTo(raw.workspaceRoot, gatewayHome, homeDir);
  }
  if (typeof raw?.dbPath === 'string') {
    raw.dbPath = resolvePathRelativeTo(raw.dbPath, gatewayHome, homeDir);
  }

  return schema.parse(raw);
}

function createDefaultConfig(defaults: {
  defaultWorkspaceRoot: string;
  defaultDbPath: string;
}): Record<string, unknown> {
  return {
    workspaceRoot: defaults.defaultWorkspaceRoot,
    dbPath: defaults.defaultDbPath,
    acpAgentCommand: 'npx',
    acpAgentArgs: ['-y', '@zed-industries/codex-acp@latest'],
    uiDefaultMode: 'verbose',
    schedulerEnabled: true,
  };
}

function isInteractiveTerminal(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

async function runFirstTimeSetup(params: {
  defaults: {
    defaultWorkspaceRoot: string;
    defaultDbPath: string;
  };
  file: string;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}): Promise<Record<string, unknown>> {
  params.output.write('\n');
  params.output.write('cli-gateway first-time setup\n');
  params.output.write(`Config file: ${params.file}\n`);
  params.output.write('Press Enter to accept defaults.\n\n');

  const rl = createInterface({
    input: params.input,
    output: params.output,
  });

  try {
    const acpAgentCommand = await askWithDefault(
      rl,
      'ACP agent command',
      'npx',
    );
    const acpArgsRaw = await askWithDefault(
      rl,
      'ACP agent args (space-separated)',
      '-y @zed-industries/codex-acp@latest',
    );
    const workspaceRoot = await askWithDefault(
      rl,
      'Default workspace root',
      params.defaults.defaultWorkspaceRoot,
    );
    const dbPath = await askWithDefault(
      rl,
      'SQLite DB path',
      params.defaults.defaultDbPath,
    );
    const schedulerEnabled = await askYesNo(rl, 'Enable scheduler', true);

    const discordToken = await askOptional(rl, 'Discord bot token (optional)');
    const discordAllowChannelId = discordToken
      ? await askOptional(rl, 'Discord allow channel id (optional)')
      : '';
    const telegramToken = await askOptional(rl, 'Telegram bot token (optional)');
    const feishuAppId = await askOptional(rl, 'Feishu app id (optional)');
    const feishuAppSecret = feishuAppId
      ? await askOptional(rl, 'Feishu app secret (optional)')
      : '';
    const feishuVerificationToken =
      feishuAppId && feishuAppSecret
        ? await askOptional(rl, 'Feishu verification token (optional)')
        : '';

    let feishuListenPort = 3030;
    if (feishuAppId && feishuAppSecret) {
      feishuListenPort = await askPortWithDefault(rl, 'Feishu listen port', 3030);
    }

    const raw: Record<string, unknown> = {
      workspaceRoot,
      dbPath,
      acpAgentCommand,
      acpAgentArgs: splitArgs(acpArgsRaw),
      uiDefaultMode: 'verbose',
      schedulerEnabled,
    };

    if (discordToken) raw.discordToken = discordToken;
    if (discordAllowChannelId) raw.discordAllowChannelId = discordAllowChannelId;
    if (telegramToken) raw.telegramToken = telegramToken;
    if (feishuAppId) raw.feishuAppId = feishuAppId;
    if (feishuAppSecret) raw.feishuAppSecret = feishuAppSecret;
    if (feishuVerificationToken) {
      raw.feishuVerificationToken = feishuVerificationToken;
    }
    if (feishuAppId && feishuAppSecret) {
      raw.feishuListenPort = feishuListenPort;
    }

    params.output.write('\nSaved config. You can edit it later at:\n');
    params.output.write(`${params.file}\n\n`);

    return raw;
  } finally {
    rl.close();
  }
}

async function askWithDefault(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer = (await rl.question(`${label} [${defaultValue}]: `)).trim();
  return answer || defaultValue;
}

async function askOptional(
  rl: ReturnType<typeof createInterface>,
  label: string,
): Promise<string> {
  return (await rl.question(`${label}: `)).trim();
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${label} [${hint}]: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return defaultValue;
}

async function askPortWithDefault(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: number,
): Promise<number> {
  const answer = (await rl.question(`${label} [${defaultValue}]: `)).trim();
  if (!answer) return defaultValue;

  const num = Number.parseInt(answer, 10);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    return defaultValue;
  }

  return num;
}

function splitArgs(raw: string): string[] {
  const parts = raw
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (parts.length > 0) return parts;
  return ['-y', '@zed-industries/codex-acp@latest'];
}
