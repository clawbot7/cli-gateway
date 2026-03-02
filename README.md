# cli-gateway

Chat-channel ↔ ACP agent gateway with scheduler.

## What it is

`cli-gateway` runs as a standalone service and lets you talk to ACP-compatible coding agents (Codex/Claude/Gemini, via ACP adapters) from:

- Discord
- Telegram
- (Feishu planned)

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

```bash
cp .env.example .env
```

3. Run

```bash
npm run dev
```

## Chat commands (MVP)

- `/new` reset session binding
- `/allow <n>` select a pending permission option by index
- `/deny` reject a pending permission request (prefers `reject_once`)
- `/cron help|list|add|del|enable|disable` manage scheduled prompts

## Security model (default)

- File system and terminal tool calls are restricted to `WORKSPACE_ROOT`.
- Tool execution is **deny-by-default**; the user must approve via ACP permission flow.
- You can persist policy choices (e.g. `allow_always` / `reject_always`) per conversation.

## Status

This repository is in active build-out; expect breaking changes.
