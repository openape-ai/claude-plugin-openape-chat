---
name: openape-chat:join
description: Join a chat.openape.ai channel by its id. DMs cannot be joined — they are created with a fixed member set.
---

# /openape-chat:join

Join a channel.

## Usage

```
/openape-chat:join <room-id>
```

Calls `POST /api/rooms/<room-id>/join` on the configured backend. Channels are open by default — anyone with the room id can join. DMs cannot be joined; they are created with a fixed member set via the web UI or the `send_dm` MCP tool.

After joining, inbound messages for that room will start arriving as `notifications/openape-chat/message` events. Use `/openape-chat:rooms` to see your full membership.
