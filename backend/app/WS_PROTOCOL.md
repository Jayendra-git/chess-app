## WebSocket message envelope

All messages between client and server use a compact JSON envelope with the following top-level fields:

- `type` (string) — the message type / action name. Required.
- `room_id` (string) — optional; present when the message targets a room.
- `payload` (object) — optional; message-specific data.

Only these top-level fields should be relied on for routing. Additional fields may be added later when new message types are introduced.

### Minimal schema (informal)

{
  "type": "...",
  "room_id": "...",   // optional
  "payload": { ... }    // optional
}

### Initial examples

- Join a room as a player (request to take the white side):

```
{
  "type": "join_room",
  "room_id": "abc123",
  "payload": {
    "role": "white"
  }
}
```

- Create a new room (no payload required):

```
{
  "type": "create_room"
}
```

- Error message from server to client:

```
{
  "type": "error",
  "message": "Room full"
}
```

### Notes and conventions

- `type` values are authoritative — implement routing based on the exact string.
- `room_id` is optional for global actions (for example `create_room`) and required for room-scoped actions (for example `join_room`, `make_move`).
- `payload` shape depends on the message `type` and will be documented per-message as we add types.
- Error messages may include a top-level `message` field for a short human-readable description; servers may also include a `code` field for machine handling.

This document will be expanded with every new supported message type. Add new examples and payload schemas here as the protocol evolves.

### Game state result

- `state.payload.result` is `null` while the game is ongoing.
- `state.payload.result` becomes:
  - `white_win` when white delivers checkmate
  - `black_win` when black delivers checkmate
  - `draw` when the position is stalemate
- Once `result` is set, the server rejects further `move` messages with `game_already_finished`.

### `move_applied` message

When a legal move is accepted, the server also broadcasts:

```json
{
  "type": "move_applied",
  "room_id": "abc123",
  "payload": {
    "move": { "from": "e2", "to": "e4", "by": "session-id" },
    "new_fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    "turn": "black",
    "result": null
  }
}
```
