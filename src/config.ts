import path from 'node:path';

import { z } from 'zod';

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  });

const absPath = z
  .string()
  .min(1)
  .refine((p) => path.isAbsolute(p), {
    message: 'must be an absolute path',
  });

const configSchema = z.object({
  discordToken: z.string().optional(),
  discordAllowChannelId: z.string().optional(),

  telegramToken: z.string().optional(),

  acpAgentCommand: z.string().min(1),
  acpAgentArgs: z.array(z.string()),

  workspaceRoot: absPath,
  dbPath: z.string().min(1),

  schedulerEnabled: z.boolean().default(true),

  runtimeIdleTtlSeconds: z
    .number()
    .int()
    .min(10)
    .default(15 * 60),
  maxBindingRuntimes: z.number().int().min(1).max(200).default(30),

  contextReplayEnabled: z.boolean().default(true),
  contextReplayRuns: z.number().int().min(0).max(50).default(8),
  contextReplayMaxChars: z.number().int().min(200).max(200_000).default(12_000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const parsed = configSchema.parse({
    discordToken: process.env.DISCORD_TOKEN,
    discordAllowChannelId: process.env.DISCORD_ALLOW_CHANNEL_ID,
    telegramToken: process.env.TELEGRAM_TOKEN,

    acpAgentCommand: process.env.ACP_AGENT_COMMAND,
    acpAgentArgs: (process.env.ACP_AGENT_ARGS ?? '')
      .split(' ')
      .map((s) => s.trim())
      .filter(Boolean),

    workspaceRoot: process.env.WORKSPACE_ROOT ?? '/tmp/cli-gateway-workspace',
    dbPath: process.env.DB_PATH ?? '.data/gateway.db',

    schedulerEnabled:
      booleanFromEnv.parse(process.env.SCHEDULER_ENABLED) ?? true,

    runtimeIdleTtlSeconds:
      Number(process.env.RUNTIME_IDLE_TTL_SECONDS ?? '') || undefined,
    maxBindingRuntimes:
      Number(process.env.MAX_BINDING_RUNTIMES ?? '') || undefined,

    contextReplayEnabled:
      booleanFromEnv.parse(process.env.CONTEXT_REPLAY_ENABLED) ?? true,
    contextReplayRuns:
      Number(process.env.CONTEXT_REPLAY_RUNS ?? '') || undefined,
    contextReplayMaxChars:
      Number(process.env.CONTEXT_REPLAY_MAX_CHARS ?? '') || undefined,
  });

  return parsed;
}
