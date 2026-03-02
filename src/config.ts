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
  });

  return parsed;
}
