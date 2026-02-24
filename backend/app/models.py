from pydantic import BaseModel, Field
from typing import Optional, List, Set

# Standard starting FEN for a chess game (includes turn, castling, en-passant, halfmove, fullmove)
STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


class State(BaseModel):
    """Represents the mutable game state for a room.

    Fields:
    - turn: which side to move ('white' or 'black')
    - moves: ordered list of SAN/PGN-like move strings (empty at start)
    - board_fen: FEN representation of the board (starts with STARTING_FEN)
    """

    turn: str = Field("white")
    moves: List[str] = Field(default_factory=list)
    board_fen: str = Field(STARTING_FEN)


class Room(BaseModel):
    """Room model describing players, spectators and game state.

    Note: although we define pydantic models for validation and convenience,
    the in-memory store keeps plain dicts so they are simple to inspect and
    serialize when needed.
    """

    room_id: str
    white_session: Optional[str] = None
    black_session: Optional[str] = None
    spectators: Set[str] = Field(default_factory=set)
    state: State = Field(default_factory=State)


__all__ = ["STARTING_FEN", "State", "Room"]
