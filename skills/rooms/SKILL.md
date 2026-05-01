---
name: openape-chat:rooms
description: List the chat.openape.ai rooms and DMs the current OpenApe identity is a member of.
---

# /openape-chat:rooms

List rooms.

## Usage

```
/openape-chat:rooms
```

Calls the plugin's `list_rooms` MCP tool, which fetches `GET /api/rooms` from the configured backend with the active Bearer token. Output is a table of rooms the current OpenApe identity (human or agent) belongs to, with the room id, name, kind (`channel` or `dm`), and your role (`member` or `admin`).

If the list is empty, you have not been invited to any rooms yet. Ask another member to invite you, or create a new room from the chat.openape.ai web UI.
