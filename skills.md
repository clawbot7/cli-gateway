# skills.md (cli-gateway)

This doc is for running `cli-gateway` with Codex/Claude/Gemini style CLI agents via ACP (stdio).

## Config location

`cli-gateway` loads all configuration from:

- `~/.cli-gateway/config.json`

Override the home directory (useful for testing):

- `CLI_GATEWAY_HOME=/path/to/dir`

On first run, `cli-gateway` creates a minimal default `config.json` if missing.

## Example config.json

Create `~/.cli-gateway/config.json`:

```json
{
  "dbPath": "~/.cli-gateway/data/gateway.db",
  "workspaceRoot": "~",

  "acpAgentCommand": "npx",
  "acpAgentArgs": ["-y", "@zed-industries/codex-acp@latest"],

  "uiDefaultMode": "verbose",
  "uiJsonMaxChars": 12000,

  "schedulerEnabled": true,
  "runtimeIdleTtlSeconds": 900,
  "maxBindingRuntimes": 30,

  "contextReplayEnabled": true,
  "contextReplayRuns": 8,
  "contextReplayMaxChars": 12000,

  "discordToken": "...",
  "discordAllowChannelId": "...",

  "telegramToken": "...",

  "feishuAppId": "...",
  "feishuAppSecret": "...",
  "feishuVerificationToken": "...",
  "feishuListenPort": 3030
}
```

Notes:
- `workspaceRoot` defaults to `~` (home dir). It is the default tool sandbox root.
- `dbPath` and `workspaceRoot` accept `~` / `~/...`.
- Relative paths are resolved relative to `~/.cli-gateway/`.

## Run (dev)

```bash
npm i
npm run dev
```

## Run (prod-ish)

```bash
npm run build
node dist/main.js
```

## Switching workspace from chat

Per conversation binding (persistent via DB):

- Show: `/workspace show` (alias: `/ws show`)
- Set: `/workspace /abs/path`
- Set to home: `/workspace ~`

Changing workspace closes the current runtime so the next message starts in the new workspace.

## Permission UX

- Discord/Telegram: interactive Allow/Deny buttons.
- Fallback: `/allow <n>` and `/deny`.

## CI / coverage

- `npm run coverage` enforces >= 90% (lines/functions/statements)
- GitHub Actions CI runs coverage on every push/PR.
