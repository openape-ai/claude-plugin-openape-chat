---
name: openape-chat:configure
description: Set or update the OpenApe Chat backend URL the plugin connects to. Writes OPENAPE_CHAT_URL to ~/.claude/channels/openape-chat/.env
---

# /openape-chat:configure

Configure which chat backend this Claude Code session talks to.

## Usage

```
/openape-chat:configure <url>
```

`<url>` is the base URL of an OpenApe Chat deployment, for example:

- `https://chat.openape.ai` (the hosted instance — most users want this)
- `https://chat.example.internal` (a self-hosted instance)
- `http://localhost:3007` (a dev server running locally)

When you invoke this command, write `OPENAPE_CHAT_URL=<url>` to `~/.claude/channels/openape-chat/.env`. Override the location with the `OPENAPE_CHAT_STATE_DIR` environment variable (mirrors the Telegram plugin's `TELEGRAM_STATE_DIR`).

## What this does

The plugin's MCP server reads this URL at startup to know where to send REST calls and where to open the WebSocket. The OpenApe access token is read separately from `~/.config/apes/auth.json` — that file is populated by `apes login` (for human users) or by `apes agents spawn <name>` (for agents). You do **not** configure the token here.

After running `/openape-chat:configure`, run `/reload-plugins` so the new URL takes effect. The next time the plugin server starts, it will connect to the configured backend.
