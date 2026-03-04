# cli-gateway Roadmap / Known Gaps

This document lists current gaps (vs a "production gateway") and the planned direction.

## Missing / Incomplete

### Memory & Recovery
- ACP session persistence: after restart, `acp_session_id` in DB is not reusable across processes (needs `session/load` support or replay strategy).
- Delivery checkpoint/replay: only best-effort; no guaranteed exactly-once delivery, no per-destination offset tracking.
- Crash mid-stream: partial output may be sent without a durable checkpoint.

### Channels
- Feishu/Lark: implemented (webhook mode) but minimal (no streaming edit, no interactive approvals).
- Discord threads: not supported (currently binds to channel id, threadId is always null).

### Tooling / Permissions
- Fine-grained policies: current persistent policy is keyed by `(binding_key, tool_kind)` only; no path/cmd scoping.
- Permission timeouts/cancellation: not implemented.
- Skills visibility: gateway only knows what ACP reports (no generic "skill invoked" UI unless agent emits a tool_call/update).

### Observability / Ops
- No health endpoint.
- No metrics.
- Minimal structured logging.

### Tests & CI
- Basic unit tests exist (migrations/uiPrefs/history).
- GitHub Actions CI runs build/lint/test.

## Implemented Recently

- Per-binding ACP runtime (1 stdio agent process per binding + per-binding queue).
- Runtime GC (idle TTL + max runtimes).
- Context replay (DB-backed) for fresh ACP sessions.
- Delivery checkpoints table + `/replay` command (best-effort).
- Interactive permission buttons on Discord/Telegram (Allow/Deny).
- Discord built-in slash command registration + handling (`/help`, `/ui`, `/cli`, `/workspace`, `/new`, `/last`, `/replay`, `/allow`, `/deny`, `/cron`).
- Process guard script for auto-restart on abnormal exit (`scripts/run-guard.sh`).
- Process guard supports daemon lifecycle commands (`start/stop/restart/status/logs`) with `nohup` background mode and auto `npm i && npm run build` on `start/restart`.
- Process guard now pre-cleans `gateway.lock` (kill lock PID if alive, remove stale lock) before each launch attempt.
- Feishu inbound webhook + outbound send (MVP).
- First-run interactive config wizard (TTY) + lock directory bootstrap.
- Default UI mode switched to `summary` (conversation-level `/ui` override still supported).
- Tool-call UI now tracks lifecycle (`start`/`update`/`complete`) keyed by tool-call id to reduce duplicate tool messages.
- Conversation preferences can now be changed before first prompt (`/ui`, `/workspace`, `/cli`) and survive `/new` session reset.
- ACP transport now fails fast on child exit/bootstrap timeout, returning explicit errors instead of leaving runs hanging.
- Discord permission approvals now support emoji reactions (`✅`/`👍` allow, `❌`/`👎` deny) in addition to buttons.
- Agent text streaming now auto-splits around tool calls (text-only updates keep editing one message; post-tool assistant output resumes in a new message).

## Suggested Next Steps (Priority)

1. Delivery reliability: write checkpoints during streaming, add replay/resume logic, add idempotency keys.
2. Add minimal tests for DB stores + context replay builder.
3. Add health endpoint + basic metrics.
4. Discord threads + Feishu streaming/edit support.
