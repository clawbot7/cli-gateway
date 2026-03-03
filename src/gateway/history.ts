import type { Db } from '../db/db.js';

export function buildReplayContextFromRecentRuns(
  db: Db,
  params: {
    sessionKey: string;
    excludeRunId: string;
    maxRuns: number;
    maxChars: number;
  },
): string {
  const runs = db
    .prepare(
      `
      SELECT run_id as runId,
             prompt_text as promptText,
             stop_reason as stopReason,
             error,
             started_at as startedAt
        FROM runs
       WHERE session_key = ? AND run_id != ?
       ORDER BY started_at DESC
       LIMIT ?
      `,
    )
    .all(params.sessionKey, params.excludeRunId, params.maxRuns) as Array<{
    runId: string;
    promptText: string;
    stopReason: string | null;
    error: string | null;
    startedAt: number;
  }>;

  const chronological = runs.slice().reverse();

  const blocks: string[] = [];

  for (const run of chronological) {
    const rows = db
      .prepare(
        'SELECT payload_json as payloadJson FROM events WHERE run_id = ? AND method = ? ORDER BY seq ASC',
      )
      .all(run.runId, 'session/update') as Array<{ payloadJson: string }>;

    let assistantText = '';
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payloadJson);
        const update = payload?.update;
        if (update?.sessionUpdate !== 'agent_message_chunk') continue;
        assistantText += update?.content?.text ?? '';
      } catch {
        // ignore malformed rows
      }
    }

    const assistantLine = assistantText.trim()
      ? assistantText.trim()
      : run.error
        ? `[error] ${run.error}`
        : run.stopReason
          ? `[stop_reason] ${run.stopReason}`
          : '';

    blocks.push(`User: ${run.promptText}`);
    if (assistantLine) blocks.push(`Assistant: ${assistantLine}`);
  }

  const raw = blocks.join('\n');
  if (!raw.trim()) return '';

  const header =
    'Context (previous messages, for continuity after restart/GC):\n';
  const full = header + raw;

  if (full.length <= params.maxChars) return full;
  return header + raw.slice(Math.max(0, raw.length - params.maxChars));
}
