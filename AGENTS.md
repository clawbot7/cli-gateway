# AGENTS.md (cli-gateway)

This file is for coding agents (Codex/Claude/etc) working in this repository.

## Project summary

`cli-gateway` is a chat-channel ↔ ACP (Agent Client Protocol) gateway with:

- Discord + Telegram + Feishu adapters
- Per-binding ACP stdio runtime isolation (one agent process per binding)
- SQLite persistence (sessions/bindings/runs/events/jobs)
- Deny-by-default tool execution via ACP `session/request_permission` (interactive buttons on DC/TG)

## Key paths

- Entry: `src/main.ts`
- Router/runtime: `src/gateway/router.ts`, `src/gateway/bindingRuntime.ts`
- ACP stdio client: `src/acp/client.ts`
- DB schema/migrations: `src/db/migrations.ts`
- Scheduler: `src/scheduler/scheduler.ts`
- Channel sinks: `src/channels/discord.ts`, `src/channels/telegram.ts`, `src/channels/feishu.ts`

## UI

- UI modes: `verbose` (default) and `summary`.
- Per-conversation override: `/ui verbose|summary` (stored in DB `ui_prefs`).

## Local dev

- Install: `npm i`
- Run: `npm run dev`
- Build: `npm run build`
- Lint: `npm run lint`

Config is env-based; see `.env.example`.

## Conventions / constraints

- TypeScript + ESM (`"type": "module"`). Keep imports with `.js` suffix in TS source.
- Prefer small, composable modules; avoid over-abstracting.
- Keep tool execution **deny-by-default**. Any expansion of tool surface must be explicitly gated.
- File/terminal tool calls must remain restricted to `WORKSPACE_ROOT`.
- Avoid adding new dependencies unless necessary.

## Persistence & migrations

- All DB schema changes go through `src/db/migrations.ts`.
- Bump `LATEST_VERSION` when adding a migration.
- Migrations must be additive and safe on existing DBs.

## "Memory" / continuity design

ACP sessions are process-local; after restart/GC the agent will start with no state.

Current mitigation:
- Context replay on fresh ACP sessions via `CONTEXT_REPLAY_*` (DB-backed replay of recent runs).

If you change how context is built or injected, update:
- `src/gateway/history.ts`
- `.env.example`
- `README.md` (Memory section)

## Delivery reliability

- `events` is append-only per run (run_id + seq).
- `delivery_checkpoints` stores last delivery state (best-effort).
- `/replay` is a best-effort recovery tool.

If you implement real resume/ack semantics, also update `ROADMAP.md`.

## Keep docs in sync

When making non-trivial changes:
- Update `ROADMAP.md`
- Update `README.md` (commands/config)
- Keep this `AGENTS.md` accurate
