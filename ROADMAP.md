# cli-gateway Roadmap / Known Gaps

This document lists current gaps (vs a "production gateway") and the planned direction.

## Missing / Incomplete

### Memory & Recovery
- ACP session persistence: after restart, `acp_session_id` in DB is not reusable across processes (needs `session/load` support or replay strategy).
- Delivery checkpoint/replay: only best-effort; no guaranteed exactly-once delivery, no per-destination offset tracking.
- Crash mid-stream: partial output may be sent without a durable checkpoint.

### Channels
- Feishu/Lark: not implemented yet (channel adapter + auth + event subscription + message send).
- Discord threads: not supported (currently binds to channel id, threadId is always null).

### Tooling / Permissions
- Fine-grained policies: current persistent policy is keyed by `(binding_key, tool_kind)` only; no path/cmd scoping.
- Permission timeouts/cancellation: not implemented.

### Observability / Ops
- No health endpoint.
- No metrics.
- Minimal structured logging.

### Tests & CI
- No automated tests.
- No CI pipeline.

## Implemented Recently

- Per-binding ACP runtime (1 stdio agent process per binding + per-binding queue).
- Runtime GC (idle TTL + max runtimes).
- Context replay (DB-backed) for fresh ACP sessions.
- Delivery checkpoints table + `/replay` command (best-effort).

## Suggested Next Steps (Priority)

1. Delivery reliability: write checkpoints during streaming, add replay/resume logic, add idempotency keys.
2. Feishu channel adapter.
3. Add minimal tests for DB stores + context replay builder.
4. Add health endpoint + basic metrics.
