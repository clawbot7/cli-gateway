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
- Feishu inbound webhook + outbound send (MVP).
- First-run interactive config wizard (TTY) + lock directory bootstrap.

## Suggested Next Steps (Priority)

1. Delivery reliability: write checkpoints during streaming, add replay/resume logic, add idempotency keys.
2. Add minimal tests for DB stores + context replay builder.
3. Add health endpoint + basic metrics.
4. Discord threads + Feishu streaming/edit support.
