from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import Any
import secrets

from .models import Room
from .store import store


app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint that handles a small message envelope.

    Currently supports: `create_room` which generates a short random room id,
    creates a `Room` with initial state, stores it in the in-memory store and
    replies with two messages:

    1) {type: "room_created", room_id}
    2) {type: "state", room_id, payload: <state>}
    """
    await websocket.accept()
    # assign a short session id for this connection
    session_id = secrets.token_hex(8)
    print(f"[WS] connection accepted session={session_id}")
    try:
        while True:
            raw = await websocket.receive_text()
            print(f"[WS] recv session={session_id} raw={raw}")
            # Expect a JSON envelope from clients
            try:
                import json

                msg = json.loads(raw)
            except Exception:
                await websocket.send_json({"type": "error", "message": "invalid_json"})
                continue

            mtype = msg.get("type")
            if not mtype:
                await websocket.send_json({"type": "error", "message": "missing_type"})
                continue

            # Handle create_room
            if mtype == "create_room":
                # short random id (8 hex chars)
                room_id = secrets.token_hex(4)
                room = Room(room_id=room_id)
                try:
                    data = await store.create_room(room)
                    print(f"[WS] created room={room_id} by session={session_id}")
                except KeyError:
                    await websocket.send_json({"type": "error", "message": "room_exists"})
                    continue

                # reply with created + initial state
                await websocket.send_json({"type": "room_created", "room_id": room_id})
                # ensure state payload is JSON serializable
                state_payload: Any = data.get("state", {})
                await websocket.send_json({"type": "state", "room_id": room_id, "payload": state_payload})
                continue

            if mtype == "join_room":
                # expected payload: { room_id, payload: { role: 'white'|'black'|'spectator' } }
                room_id = msg.get("room_id")
                payload = msg.get("payload") or {}
                role = payload.get("role")
                if role not in ("white", "black", "spectator"):
                    await websocket.send_json({"type": "error", "message": "invalid_role"})
                    continue
                if not room_id:
                    await websocket.send_json({"type": "error", "message": "missing_room_id"})
                    continue

                try:
                    room = await store.join_room(room_id=room_id, session_id=session_id, role=role, websocket=websocket)
                    print(f"[WS] session={session_id} joined room={room_id} as {role}")
                except KeyError:
                    await websocket.send_json({"type": "error", "message": "room_not_found"})
                    continue
                except ValueError as e:
                    await websocket.send_json({"type": "error", "message": str(e)})
                    continue

                # success: reply with a join confirmation and current state
                await websocket.send_json({"type": "joined", "room_id": room_id, "role": role, "session_id": session_id})
                state_payload: Any = room.get("state", {})
                await websocket.send_json({"type": "state", "room_id": room_id, "payload": state_payload})
                continue

            if mtype == "move":
                # payload expected: { from: 'e2', to: 'e4' }
                payload = msg.get("payload") or {}
                src = payload.get("from")
                dst = payload.get("to")
                if not src or not dst:
                    await websocket.send_json({"type": "error", "message": "invalid_move_payload"})
                    continue

                # find which room this session is in
                session_info = await store.get_session(session_id)
                if not session_info:
                    await websocket.send_json({"type": "error", "message": "not_in_room"})
                    continue

                room_id = session_info.get("room_id")
                role = session_info.get("role")
                # spectators may not send moves
                if role == "spectator":
                    await websocket.send_json({"type": "error", "message": "spectators_cannot_move", "room_id": room_id})
                    continue
                # retrieve room
                room = await store.get_room(room_id)
                if not room:
                    await websocket.send_json({"type": "error", "message": "room_not_found"})
                    continue

                # use store.apply_move to atomically apply the move under the
                # store lock and get snapshots for broadcasting outside the lock
                try:
                    conns_snapshot, new_state, move_obj = await store.apply_move(
                        room_id=room_id, session_id=session_id, src=src, dst=dst
                    )
                except KeyError:
                    await websocket.send_json({"type": "error", "message": "room_not_found"})
                    continue
                except ValueError as e:
                    # propagate move-related errors as client-visible errors
                    await websocket.send_json({"type": "error", "message": str(e), "room_id": room_id})
                    continue

                # broadcast updated state and the raw move envelope
                try:
                    await store.broadcast_state(room_id, conns_snapshot, new_state)
                except Exception as e:
                    print(f"[WS] broadcast_state error after apply_move: {e}")

                try:
                    # send a compact 'move_applied' envelope in addition to the
                    # full state broadcast so clients can react to the move
                    await store.broadcast_move_applied(
                        room_id,
                        conns_snapshot,
                        move_obj,
                        new_state,
                        result=new_state.get("result"),
                    )
                except Exception as e:
                    print(f"[WS] broadcast_move_applied error: {e}")

                continue

            # Unknown message types are echoed back as an error for now
            await websocket.send_json({"type": "error", "message": f"unknown_type: {mtype}"})
    except WebSocketDisconnect:
        print(f"[WS] disconnect session={session_id}")
        # clean up session mapping if present and remove websocket reference
        try:
            await store.leave_room(session_id, websocket=websocket)
        except Exception:
            pass
        # client disconnected -- nothing to do
        pass
