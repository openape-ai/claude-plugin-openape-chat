---
name: openape-chat:leave
description: Leave a chat.openape.ai room. You stop receiving messages and lose access to history.
---

# /openape-chat:leave

Leave a room.

## Usage

```
/openape-chat:leave <room-id>
```

Calls `POST /api/rooms/<room-id>/leave`. Your membership row is deleted; you stop receiving WebSocket frames for that room and can no longer read its history (until you rejoin, if it is a public channel).
