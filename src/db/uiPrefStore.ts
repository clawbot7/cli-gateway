import type { Db } from './db.js';
import type { UiMode } from '../gateway/types.js';

export function getUiMode(db: Db, bindingKey: string): UiMode | null {
  const row = db
    .prepare('SELECT mode FROM ui_prefs WHERE binding_key = ?')
    .get(bindingKey) as { mode: string } | undefined;

  if (!row) return null;
  return row.mode === 'summary' ? 'summary' : 'verbose';
}

export function setUiMode(db: Db, bindingKey: string, mode: UiMode): void {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO ui_prefs(binding_key, mode, created_at, updated_at)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(binding_key) DO UPDATE SET
      mode = excluded.mode,
      updated_at = excluded.updated_at
    `,
  ).run(bindingKey, mode, now, now);
}
