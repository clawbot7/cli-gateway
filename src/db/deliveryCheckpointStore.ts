import type { Db } from './db.js';

export type DeliveryCheckpointRow = {
  bindingKey: string;
  runId: string;
  lastSeq: number;
  messageId: string | null;
  text: string;
  createdAt: number;
  updatedAt: number;
};

export function getDeliveryCheckpoint(
  db: Db,
  params: { bindingKey: string; runId: string },
): DeliveryCheckpointRow | null {
  const row = db
    .prepare(
      `
      SELECT binding_key as bindingKey,
             run_id as runId,
             last_seq as lastSeq,
             message_id as messageId,
             text,
             created_at as createdAt,
             updated_at as updatedAt
        FROM delivery_checkpoints
       WHERE binding_key = ? AND run_id = ?
      `,
    )
    .get(params.bindingKey, params.runId) as DeliveryCheckpointRow | undefined;

  return row ?? null;
}

export function upsertDeliveryCheckpoint(
  db: Db,
  params: {
    bindingKey: string;
    runId: string;
    lastSeq: number;
    messageId: string | null;
    text: string;
  },
): void {
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO delivery_checkpoints(binding_key, run_id, last_seq, message_id, text, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(binding_key, run_id) DO UPDATE SET
      last_seq = excluded.last_seq,
      message_id = excluded.message_id,
      text = excluded.text,
      updated_at = excluded.updated_at
    `,
  ).run(
    params.bindingKey,
    params.runId,
    params.lastSeq,
    params.messageId,
    params.text,
    now,
    now,
  );
}
