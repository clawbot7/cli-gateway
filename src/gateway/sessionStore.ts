import type { Db } from '../db/db.js';

export type Platform = 'discord' | 'telegram' | 'feishu';

export type ConversationKey = {
  platform: Platform;
  chatId: string;
  threadId: string | null;
  userId: string;
};

export type SessionBinding = {
  bindingKey: string;
  sessionKey: string;
};

export function bindingKeyFromConversationKey(key: ConversationKey): string {
  return [key.platform, key.chatId, key.threadId ?? '-', key.userId].join(':');
}

export function getBinding(
  db: Db,
  key: ConversationKey,
): SessionBinding | null {
  const bindingKey = bindingKeyFromConversationKey(key);
  const row = db
    .prepare(
      'SELECT binding_key as bindingKey, session_key as sessionKey FROM bindings WHERE binding_key = ?',
    )
    .get(bindingKey) as SessionBinding | undefined;
  return row ?? null;
}

export function upsertBinding(
  db: Db,
  key: ConversationKey,
  sessionKey: string,
): SessionBinding {
  const bindingKey = bindingKeyFromConversationKey(key);
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO bindings(binding_key, platform, chat_id, thread_id, user_id, session_key, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(binding_key) DO UPDATE SET
      session_key = excluded.session_key,
      updated_at = excluded.updated_at
    `,
  ).run(
    bindingKey,
    key.platform,
    key.chatId,
    key.threadId,
    key.userId,
    sessionKey,
    now,
    now,
  );

  return { bindingKey, sessionKey };
}

export function deleteBinding(db: Db, key: ConversationKey): void {
  const bindingKey = bindingKeyFromConversationKey(key);
  db.prepare('DELETE FROM bindings WHERE binding_key = ?').run(bindingKey);
}

export function createSession(
  db: Db,
  params: {
    sessionKey: string;
    agentCommand: string;
    agentArgs: string[];
    cwd: string;
    loadSupported: boolean;
  },
): void {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO sessions(session_key, agent_command, agent_args_json, acp_session_id, load_supported, cwd, created_at, updated_at)
    VALUES(?, ?, ?, NULL, ?, ?, ?, ?)
    `,
  ).run(
    params.sessionKey,
    params.agentCommand,
    JSON.stringify(params.agentArgs),
    params.loadSupported ? 1 : 0,
    params.cwd,
    now,
    now,
  );
}

export function updateAcpSessionId(
  db: Db,
  sessionKey: string,
  acpSessionId: string,
): void {
  const now = Date.now();
  db.prepare(
    'UPDATE sessions SET acp_session_id = ?, updated_at = ? WHERE session_key = ?',
  ).run(acpSessionId, now, sessionKey);
}

export function getSession(
  db: Db,
  sessionKey: string,
): {
  sessionKey: string;
  agentCommand: string;
  agentArgsJson: string;
  acpSessionId: string | null;
  cwd: string;
  loadSupported: number;
} | null {
  const row = db
    .prepare(
      'SELECT session_key as sessionKey, agent_command as agentCommand, agent_args_json as agentArgsJson, acp_session_id as acpSessionId, cwd, load_supported as loadSupported FROM sessions WHERE session_key = ?',
    )
    .get(sessionKey) as any;
  return row ?? null;
}

export function createRun(
  db: Db,
  params: { runId: string; sessionKey: string; promptText: string },
): void {
  db.prepare(
    'INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)',
  ).run(params.runId, params.sessionKey, params.promptText, Date.now());
}

export function finishRun(
  db: Db,
  params: { runId: string; stopReason?: string; error?: string },
): void {
  db.prepare(
    'UPDATE runs SET ended_at = ?, stop_reason = ?, error = ? WHERE run_id = ?',
  ).run(
    Date.now(),
    params.stopReason ?? null,
    params.error ?? null,
    params.runId,
  );
}
