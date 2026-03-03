import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export function loadConfig(): AppConfig {
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
    raw = {
      workspaceRoot: defaults.defaultWorkspaceRoot,
      dbPath: defaults.defaultDbPath,
      acpAgentCommand: 'npx',
      acpAgentArgs: ['-y', '@zed-industries/codex-acp@latest'],
      uiDefaultMode: 'verbose',
      schedulerEnabled: true,
    };

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
