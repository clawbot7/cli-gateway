# cli-gateway

Chat-channel ↔ ACP agent gateway with scheduler.

## What it is

`cli-gateway` runs as a standalone service and lets you talk to ACP-compatible coding agents (Codex/Claude/Gemini, via ACP adapters) from:

- Discord
- Telegram
- Feishu (webhook mode, MVP)

It uses **one ACP stdio agent process per conversation binding** to avoid cross-talk and support concurrency.

It implements ACP stdio transport (JSON-RPC 2.0 over newline-delimited JSON) and supports the Client-side tool surface:

- `session/update` streaming
- `session/request_permission`
- `fs/read_text_file`, `fs/write_text_file`
- `terminal/*`

ACP refs:

- Overview: https://agentclientprotocol.com/protocol/overview
- Initialization: https://agentclientprotocol.com/protocol/initialization
- Transports: https://agentclientprotocol.com/protocol/transports
- Schema: https://agentclientprotocol.com/protocol/schema

## Quickstart

1. Install dependencies

```bash
npm i
```

2. Configure

On first run, `cli-gateway` creates a default config file at:

- `~/.cli-gateway/config.json`

Edit that file to add tokens / agent command / defaults. See `skills.md`.

3. Run

```bash
npm run dev
```

## Feishu setup (MVP)

Feishu currently runs in webhook event-subscription mode:

- Listener: `http(s)://<host>:FEISHU_LISTEN_PORT/feishu/events`
- Config file keys: `feishuAppId`, `feishuAppSecret`, `feishuVerificationToken`, `feishuListenPort`
- Assumption: event payloads are **not** encrypted (no encrypt key)

## Chat commands (MVP)

- `/new` reset session binding
- `/allow <n>` select a pending permission option by index (fallback)
- `/deny` reject a pending permission request (fallback)
- `/cron help|list|add|del|enable|disable` manage scheduled prompts
- `/last` show last run output for this session
- `/replay [runId]` replay stored `session/update` output for a run (best-effort)
- `/ui verbose|summary` set UI verbosity for this conversation
- `/workspace show|~|~/...|/abs/path` show/set per-conversation workspace root (alias: `/ws`)

## Security model (default)

- File system and terminal tool calls are restricted to the active workspace root (per conversation; see `/workspace`).
- Tool execution is **deny-by-default**; the user must approve via ACP permission flow.
- Approvals are interactive (buttons) on Discord/Telegram; `/allow`/`/deny` remain as fallback.
- You can persist policy choices (e.g. `allow_always` / `reject_always`) per conversation.

## UI modes

- `verbose` (default): show structured messages for tool execution + plan/task updates.
- `summary`: quieter.

Set per conversation: `/ui verbose|summary`.

## Memory (context replay)

ACP sessions are process-local; if the gateway restarts (or an idle runtime is GC'ed), the new ACP session would otherwise start "blank".

To reduce this, `cli-gateway` can replay recent conversation runs from the DB into the first prompt of a fresh ACP session:

- Env: `CONTEXT_REPLAY_ENABLED`, `CONTEXT_REPLAY_RUNS`, `CONTEXT_REPLAY_MAX_CHARS`
- Default: enabled, last 8 runs, max 12k chars

## Status

This repository is in active build-out; expect breaking changes.
