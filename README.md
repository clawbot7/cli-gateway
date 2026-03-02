# cli-gateway

Chat-channel ↔ ACP agent gateway with scheduler.

## What it is

`cli-gateway` runs as a standalone service and lets you talk to ACP-compatible coding agents (Codex/Claude/Gemini, via ACP adapters) from:

- Discord
- Telegram
- (Feishu planned)

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
- `/allow <n>` allow the pending permission option by index
- `/deny` deny the pending permission request

## Security model (default)

- File system and terminal tool calls are restricted to `WORKSPACE_ROOT`.
- Potentially destructive tool calls require user confirmation.

## Status

This repository is in active build-out; expect breaking changes.
