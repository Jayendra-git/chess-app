from typing import Dict, Optional, Any
import asyncio

from .models import Room


class InMemoryStore:
    """A very small async-friendly in-memory store for rooms.

    It wraps a dict and an asyncio.Lock to make simple operations atomic.
    Stored values are plain dicts (Room.dict()).
    """

    def __init__(self) -> None:
        self._rooms = {}  # type: Dict[str, dict]
        self._lock = asyncio.Lock()
        # map session_id -> {room_id, role}
        self._sessions = {}  # type: Dict[str, Any]

    async def list_rooms(self) -> Dict[str, dict]:
        async with self._lock:
            return dict(self._rooms)

    async def get_room(self, room_id: str) -> Optional[dict]:
        async with self._lock:
            return self._rooms.get(room_id)

    async def create_room(self, room: Room) -> dict:
        async with self._lock:
            if room.room_id in self._rooms:
                raise KeyError(f"room exists: {room.room_id}")
            data = room.dict()
            # ensure spectators is a set (pydantic produces set, but keep defensive)
            data["spectators"] = set(data.get("spectators") or [])
            # connections holds active websocket objects for broadcasting
            data["connections"] = []
            self._rooms[room.room_id] = data
            print(f"[STORE] create_room: {room.room_id}")
            return data

    async def upsert_room(self, room: Room) -> dict:
        async with self._lock:
            data = room.dict()
            data["spectators"] = set(data.get("spectators") or [])
            self._rooms[room.room_id] = data
            print(f"[STORE] upsert_room: {room.room_id}")
            return data

    async def delete_room(self, room_id: str) -> None:
        async with self._lock:
            removed = self._rooms.pop(room_id, None)
            print(f"[STORE] delete_room: {room_id} removed={removed is not None}")

    async def join_room(self, room_id: str, session_id: str, role: str, websocket=None) -> dict:
        """Join a room with a session id and role.

        role is one of 'white', 'black', 'spectator'. If a player role is
        already taken, raises ValueError.
        The websocket object (optional) will be appended to the room's
        connections list for later broadcasting.
        """
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                raise KeyError(room_id)

            if role == "white":
                if room.get("white_session"):
                    raise ValueError("white_taken")
                room["white_session"] = session_id
            elif role == "black":
                if room.get("black_session"):
                    raise ValueError("black_taken")
                room["black_session"] = session_id
            else:
                # spectator
                specs = room.get("spectators") or set()
                specs.add(session_id)
                room["spectators"] = specs

            # register session mapping
            self._sessions[session_id] = {"room_id": room_id, "role": role}
            print(f"[STORE] join_room: room={room_id} session={session_id} role={role}")

            # store websocket reference for broadcasting (if provided)
            if websocket is not None:
                conns = room.get("connections")
                if conns is None:
                    conns = []
                    room["connections"] = conns
                conns.append(websocket)
                print(f"[STORE] join_room: appended websocket for session={session_id} total_conns={len(conns)}")

            # capture a snapshot of state and connections to broadcast after
            # releasing the lock
            conns_snapshot = list(room.get("connections") or [])
            state_snapshot = room.get("state")

        # outside lock: broadcast updated state
        try:
            await self.broadcast_state(room_id, conns_snapshot, state_snapshot)
        except Exception as e:
            print(f"[STORE] broadcast_state error after join: {e}")

        return room

    async def leave_room(self, session_id: str, websocket=None) -> None:
        """Remove a session from whichever room it was in and remove websocket refs.

        If `websocket` is provided, remove that object from the room's
        connections list as part of cleanup.
        """
        async with self._lock:
            info = self._sessions.pop(session_id, None)
            if not info:
                # still attempt to remove websocket from any room connections
                if websocket is not None:
                    # scan rooms and remove websocket if found
                    for rid, room in self._rooms.items():
                        conns = room.get("connections") or []
                        if websocket in conns:
                            room["connections"] = [c for c in conns if c is not websocket]
                            print(f"[STORE] leave_room: removed websocket for unknown session from room={rid}")
                return
            room_id = info.get("room_id")
            role = info.get("role")
            room = self._rooms.get(room_id)
            if not room:
                return

            # remove websocket reference if provided
            if websocket is not None:
                conns = room.get("connections") or []
                if websocket in conns:
                    room["connections"] = [c for c in conns if c is not websocket]
                    print(f"[STORE] leave_room: removed websocket object for session={session_id} from room={room_id}")

            if role == "white" and room.get("white_session") == session_id:
                room["white_session"] = None
            elif role == "black" and room.get("black_session") == session_id:
                room["black_session"] = None
            else:
                specs = room.get("spectators") or set()
                specs.discard(session_id)
                room["spectators"] = specs

            print(f"[STORE] leave_room: removed session={session_id} from room={room_id} role={role}")

            # snapshot connections and state to broadcast after releasing lock
            conns_snapshot = list(room.get("connections") or [])
            state_snapshot = room.get("state")

        # broadcast new state to remaining connections
        try:
            await self.broadcast_state(room_id, conns_snapshot, state_snapshot)
        except Exception as e:
            print(f"[STORE] broadcast_state error after leave: {e}")

    async def update_state(self, room_id: str, *, state: dict) -> dict:
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                raise KeyError(room_id)
            # replace state dict
            room["state"] = state
            print(f"[STORE] update_state: {room_id} new_state={state}")
            conns_snapshot = list(room.get("connections") or [])

        # broadcast new state outside the lock
        try:
            await self.broadcast_state(room_id, conns_snapshot, state)
        except Exception as e:
            print(f"[STORE] broadcast_state error after update_state: {e}")

        return room

    async def broadcast_state(self, room_id: str, connections: list, state: dict) -> None:
        """Send the state envelope to all websocket connections in the list.

        connections is a snapshot list of websocket objects; dead connections
        will be removed from the room's connections list.
        """
        if not connections:
            return

        bad = []
        payload = {"type": "state", "room_id": room_id, "payload": state}
        for ws in connections:
            try:
                # starlette WebSocket provides send_json
                await ws.send_json(payload)
            except Exception as e:
                print(f"[STORE] broadcast_state: send failed for room={room_id} err={e}")
                bad.append(ws)

        if not bad:
            return

        # remove bad connections under lock
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return
            conns = room.get("connections") or []
            room["connections"] = [c for c in conns if c not in bad]
            print(f"[STORE] broadcast_state: removed {len(bad)} dead connections from room={room_id}")

    async def broadcast_move(self, room_id: str, connections: list, move: dict) -> None:
        """Send a move envelope to all websocket connections in the list.

        Removes dead connections similarly to broadcast_state.
        """
        if not connections:
            return

        bad = []
        payload = {"type": "move", "room_id": room_id, "payload": move}
        for ws in connections:
            try:
                await ws.send_json(payload)
            except Exception as e:
                print(f"[STORE] broadcast_move: send failed for room={room_id} err={e}")
                bad.append(ws)

        if not bad:
            return

        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return
            conns = room.get("connections") or []
            room["connections"] = [c for c in conns if c not in bad]
            print(f"[STORE] broadcast_move: removed {len(bad)} dead connections from room={room_id}")

    async def get_session(self, session_id: str) -> Optional[dict]:
        async with self._lock:
            return self._sessions.get(session_id)


# module-level singleton store
store = InMemoryStore()


__all__ = ["InMemoryStore", "store"]
