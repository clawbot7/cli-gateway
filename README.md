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

## Quickstart (Published Package)

Requirements:

- Node.js >= 18

1. Install

Option A (global):

```bash
npm i -g cli-gateway
```

Option B (no global install):

```bash
npx -y cli-gateway
```

2. Configure

On first run, if config is missing, `cli-gateway` opens an interactive setup wizard and writes:

- `~/.cli-gateway/config.json`

You can edit that file any time to update tokens / agent command / defaults. See `skills.md`.

3. Run

If installed globally:

```bash
cli-gateway
```

If using `npx`, use the same command each time:

```bash
npx -y cli-gateway
```

## Local Development

```bash
npm i
npm run dev
```

## Process Guard (Auto Restart)

For crash protection in long-running deployments, `run-guard.sh` now runs as a background daemon with `nohup`, supports lifecycle commands, and automatically updates/builds on startup.

Start guard (default app command: `node dist/main.js`):

```bash
npm run start:guard
```

Restart/stop/status/logs:

```bash
bash scripts/run-guard.sh restart
bash scripts/run-guard.sh stop
bash scripts/run-guard.sh status
bash scripts/run-guard.sh logs
```

Custom command is supported:

```bash
bash scripts/run-guard.sh start -- npm run dev
bash scripts/run-guard.sh restart -- npm run dev
```

`start`/`restart` automatically runs:

```bash
npm i
npm run build
```

Then guard keeps restarting the app on abnormal exit with exponential backoff.
Before each launch attempt, guard also checks `gateway.lock` under `CLI_GATEWAY_HOME` (or `~/.cli-gateway`), terminates the lock PID if still alive, and removes stale lock files.

Useful env vars:

- `RESTART_BASE_DELAY_SECONDS` (default `2`)
- `RESTART_MAX_DELAY_SECONDS` (default `30`)
- `RESTART_MAX_ATTEMPTS` (default `0`, unlimited)
- `RESTART_ON_EXIT_0` (default `0`)
- `STOP_TIMEOUT_SECONDS` (default `20`)
- `SKIP_UPDATE=1` to skip `npm i` + `npm run build`
- `GUARD_STATE_DIR` to override pid/log directory (default `./.run-guard`)

## Feishu setup (MVP)

Feishu currently runs in webhook event-subscription mode:

- Listener: `http(s)://<host>:<feishuListenPort>/feishu/events`
- Config file keys: `feishuAppId`, `feishuAppSecret`, `feishuVerificationToken`, `feishuListenPort`
- Assumption: event payloads are **not** encrypted (no encrypt key)

## Chat commands (MVP)

- `/help` show available commands
- `/new` start a fresh ACP session for this conversation
- `/allow <n>` select a pending permission option by index (fallback)
- `/deny` reject a pending permission request (fallback)
- `/cron help|list|add|del|enable|disable` manage scheduled prompts
- `/last` show last run output for this session
- `/replay [runId]` replay stored `session/update` output for a run (best-effort)
- `/ui verbose|summary` set UI verbosity for this conversation
- `/cli show|codex|claude` show/switch ACP CLI preset for this conversation
- Claude preset uses `@zed-industries/claude-code-acp`; make sure Claude auth is available (for example `ANTHROPIC_API_KEY` or Claude `/login`).
- ACP startup failures now fail fast (exit/timeout) and return an explicit error instead of hanging the conversation.
- `/workspace show|~|~/...|/abs/path` show/set per-conversation workspace root (alias: `/ws`)
- `/help` also includes ACP `available_commands_update` entries as `cli-inline` commands (best-effort)

Telegram note:
- Chat-scoped command menu is synced best-effort from `cli-inline` commands. Commands with `-` are mapped to `_` in Telegram UI.

Discord note:
- Built-in commands are available as slash commands (`/help`, `/ui`, `/cli`, `/workspace`, `/new`, `/last`, `/replay`, `/allow`, `/deny`, `/cron`).
- Slash commands are synced at startup (global + per-guild best-effort). Global command propagation may take time on Discord side.
- ACP `cli-inline` dynamic commands are not yet exposed as Discord slash commands.
- Inbound message processing uses reaction acks (`🤔` while running, then `🕊` on success or `😢` on error), aligned with Telegram behavior.

## Security model (default)

- File system and terminal tool calls are restricted to the active workspace root (per conversation; see `/workspace`).
- Tool execution is **deny-by-default**; the user must approve via ACP permission flow.
- Approvals are interactive on Discord/Telegram (buttons). Discord permission cards also add reaction shortcuts (`👍` allow, `👎` deny; `✅`/`❌` still accepted); `/allow`/`/deny` remain as fallback.
- You can persist policy choices (e.g. `allow_always` / `reject_always`) per conversation.

## UI modes

- `summary` (default): quieter.
- `verbose`: show structured messages for tool execution + plan/task updates.

Set per conversation: `/ui verbose|summary`.
Tool-call UI is lifecycle-based (`started`/`running`/`completed`) and updates by tool-call id when supported by the channel sink.
Agent text is streamed by editing one message while output is text-only; when a tool call starts, the next agent text segment resumes in a new message.

## Conversation isolation

- Discord:
  - DM: isolated per user (DM channel)
  - Guild channel: isolated per channel (shared across members in that channel)
- Telegram:
  - Private chat: isolated per user
  - Group/supergroup/topic: isolated per chat (and topic thread when present)
- Workspace root (`/workspace`) and run history follow the same binding scope.
- `/new` starts a fresh ACP session but keeps conversation-scoped preferences (UI mode, workspace root, CLI preset, permission policies).

## Memory (context replay)

ACP sessions are process-local; if the gateway restarts (or an idle runtime is GC'ed), the new ACP session would otherwise start "blank".

To reduce this, `cli-gateway` can replay recent conversation runs from the DB into the first prompt of a fresh ACP session:

- Config keys: `contextReplayEnabled`, `contextReplayRuns`, `contextReplayMaxChars`
- Default: enabled, last 8 runs, max 12k chars (used only on fresh ACP sessions)

## Status

This repository is in active build-out; expect breaking changes.
