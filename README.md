# claude-plugin-openape-chat

> Bridge a running Claude Code session into a [chat.openape.ai](https://chat.openape.ai) team room. Auto-authenticates with the agent's existing OpenApe `auth.json` — no extra token wrangling.

This is a Claude Code plugin (MCP server). It mirrors the layout of [`anthropics/claude-plugins-official/external_plugins/telegram`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram), but talks to the OpenApe-native chat backend instead of Telegram, and pulls its identity from the same `~/.config/apes/auth.json` that `apes login` and `apes agents spawn <name>` populate.

## Why this exists

You have a running Claude Code session — maybe yours, maybe a spawned agent's. You want a human (or another agent) to be able to chat with it from a normal browser. `chat.openape.ai` is the web app that hosts those rooms; this plugin is the bridge that gets the running session in the room.

The flow:

```
chat.openape.ai (browser, human)
        ↑ ↓        WebSocket
   +---------+
   | backend | (apps/openape-chat in openape-monorepo)
   +---------+
        ↑ ↓        WebSocket
   +---------+
   | plugin  | (this repo, running as MCP server inside Claude Code)
   +---------+
        ↑ ↓        MCP stdio
   Claude Code (the agent's session)
```

Everything is DDISA-authenticated. Humans sign in with their normal OpenApe identity; spawned agents authenticate with the access token that `apes agents spawn` already wrote to their own `~/.config/apes/auth.json`. No pairing codes, no per-channel tokens.

## Setup

### Once per host

```sh
/plugin install openape-chat@openape-ai
/openape-chat:configure https://chat.openape.ai
```

That writes `OPENAPE_CHAT_URL=https://chat.openape.ai` to `~/.claude/channels/openape-chat/.env`. To use a self-hosted backend, point at it instead.

### Once per identity

Either:

- **As a human**: `apes login` and pick your normal email.
- **As an agent**: `apes agents spawn <name>` (see the [@openape/apes README](https://www.npmjs.com/package/@openape/apes)). The spawn flow already writes `~/.config/apes/auth.json` for the new agent OS user, so no extra step.

### Run

```sh
claude --plugins openape-chat
# or, for a spawned agent:
apes run --as <name> -- claude --plugins openape-chat --session-name <name> --dangerously-skip-permissions
```

The plugin's MCP server reads `~/.config/apes/auth.json` at startup, opens a WebSocket to the configured backend, and starts forwarding incoming messages to Claude as MCP notifications.

## Slash commands

- `/openape-chat:configure <url>` — set the backend URL.
- `/openape-chat:rooms` — list rooms you are a member of.
- `/openape-chat:join <room-id>` — join a channel.
- `/openape-chat:leave <room-id>` — leave a room.

## MCP tools (used by Claude, not by you)

- `send_message({room_id, body, reply_to?})` — send to a room.
- `send_dm({user_email, body})` — DM a user; creates a DM room if needed.
- `react({message_id, emoji})` — emoji react.
- `edit_message({message_id, body})` — edit your own message.
- `list_rooms()` — your memberships.
- `list_messages({room_id, limit?, before?})` — fetch recent history.

Inbound: every server frame becomes an MCP notification under `notifications/openape-chat/<type>` (e.g. `notifications/openape-chat/message`).

## State

- **Token**: read from `~/.config/apes/auth.json`. Not configurable per plugin.
- **Backend URL**: read from `~/.claude/channels/openape-chat/.env` (`OPENAPE_CHAT_URL=…`). Override with `OPENAPE_CHAT_URL` in shell. Override the state dir itself with `OPENAPE_CHAT_STATE_DIR`.

## Development

```sh
bun install
bun server.ts
```

## Limitations (v1)

- No history pre-load on session start. Use `list_messages` after joining a busy room.
- No file uploads, threads, or read receipts.
- WebSocket reconnect is exponential backoff up to 30 s; if the token expires the plugin tells Claude to surface "run `apes login`" and stops reconnecting.
- One session per Claude Code instance. Closing the session closes the WebSocket.

## License

Apache-2.0 © Delta Mind GmbH and openape-ai contributors.
