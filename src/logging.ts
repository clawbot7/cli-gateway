export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function shouldLog(level: LogLevel): boolean {
  return levelOrder[level] >= levelOrder[currentLevel];
}

export const log = {
  debug: (...args: unknown[]) => {
    if (shouldLog('debug')) console.log('[debug]', ...args);
  },
  info: (...args: unknown[]) => {
    if (shouldLog('info')) console.log('[info]', ...args);
  },
  warn: (...args: unknown[]) => {
    if (shouldLog('warn')) console.warn('[warn]', ...args);
  },
  error: (...args: unknown[]) => {
    if (shouldLog('error')) console.error('[error]', ...args);
  },
};
