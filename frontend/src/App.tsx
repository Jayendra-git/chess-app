import { useEffect, useRef, useState } from 'react'
import ChessboardWrapper from './ChessboardWrapper'
import './App.css'

type PlayerRole = 'white' | 'black' | 'spectator'
type Page = 'room' | 'game'

function getResultCopy(result: 'white_win' | 'black_win' | 'draw' | null | undefined) {
  switch (result) {
    case 'white_win':
      return {
        title: 'White wins',
        description: 'The game is over by checkmate.',
      }
    case 'black_win':
      return {
        title: 'Black wins',
        description: 'The game is over by checkmate.',
      }
    case 'draw':
      return {
        title: 'Draw',
        description: 'The game ended in a draw by stalemate.',
      }
    default:
      return null
  }
}

function getPageFromHash(): Page {
  return window.location.hash === '#/game' ? 'game' : 'room'
}

function getWebSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL?.trim()
  if (configuredUrl) {
    return configuredUrl
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const { hostname, host } = window.location
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1'

  if (isLocalHost) {
    return `${protocol}://${hostname}:8000/ws`
  }

  return `${protocol}://${host}/ws`
}

function App() {
  const [page, setPage] = useState<Page>(() => getPageFromHash())
  const [messages, setMessages] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)
  const [currentRole, setCurrentRole] = useState<PlayerRole | null>(null)
  const [joinRoomInput, setJoinRoomInput] = useState<string>('')
  const [joinRole, setJoinRole] = useState<PlayerRole>('white')
  const [roomState, setRoomState] = useState<any | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const resultCopy = getResultCopy(roomState?.result)

  useEffect(() => {
    const syncPageFromHash = () => setPage(getPageFromHash())

    window.addEventListener('hashchange', syncPageFromHash)
    syncPageFromHash()

    return () => {
      window.removeEventListener('hashchange', syncPageFromHash)
    }
  }, [])

  useEffect(() => {
    // Open websocket when component mounts.
    const url = getWebSocketUrl()
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.addEventListener('open', () => {
      setConnected(true)
    })

    ws.addEventListener('message', (ev: MessageEvent<string>) => {
      // attempt to parse JSON envelope first
      try {
        const obj = JSON.parse(ev.data)
        const t = obj.type
        if (t === 'room_created') {
          const id = obj.room_id
          setRoomId(id)
          setJoinRoomInput(id)
          setMessages((m: string[]) => [...m, `Room created: ${id}`])
          // auto-join as white by default
          const joinMsg = { type: 'join_room', room_id: id, payload: { role: 'white' } }
          const w = wsRef.current
          if (w && w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify(joinMsg))
            setMessages((m: string[]) => [...m, `Auto-joining room ${id} as white`])
          }
          return
        }

        if (t === 'joined') {
          setRoomId(obj.room_id)
          setJoinRoomInput(obj.room_id)
          setJoined(true)
          setCurrentRole(obj.role)
          setMessages((m: string[]) => [...m, `Joined room ${obj.room_id} as ${obj.role}`])
          window.location.hash = '/game'
          return
        }

        if (t === 'state') {
          const payload = obj.payload
          setRoomState(payload)
          setMessages((m: string[]) => [...m, `State for ${obj.room_id}: ${JSON.stringify(payload)}`])
          return
        }

        if (t === 'error') {
          setMessages((m: string[]) => [...m, `Error: ${obj.message || JSON.stringify(obj)}`])
          return
        }

        // fall back: append raw message
        setMessages((m: string[]) => [...m, ev.data])
      } catch {
        // not JSON, just append raw text
        setMessages((m: string[]) => [...m, ev.data])
      }
    })

    ws.addEventListener('close', () => {
      setConnected(false)
    })

    ws.addEventListener('error', () => {
      setConnected(false)
    })

    return () => {
      ws.close()
    }
  }, [])

  function createRoom() {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg = { type: 'create_room' }
      ws.send(JSON.stringify(msg))
      setMessages((m: string[]) => [...m, 'Sent: create_room'])
    } else {
      setMessages((m: string[]) => [...m, 'WebSocket not connected'])
    }
  }

  function joinRoom() {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg = { type: 'join_room', room_id: joinRoomInput, payload: { role: joinRole } }
      ws.send(JSON.stringify(msg))
      setMessages((m: string[]) => [...m, `Sent join_room ${joinRoomInput} as ${joinRole}`])
    } else {
      setMessages((m: string[]) => [...m, 'WebSocket not connected'])
    }
  }

  function handleBoardMove(sourceSquare: string, targetSquare: string | null) {
    if (!targetSquare) return false

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setMessages((m: string[]) => [...m, 'WebSocket not connected'])
      return false
    }

    const msg = {
      type: 'move',
      payload: {
        from: sourceSquare,
        to: targetSquare,
      },
    }

    ws.send(JSON.stringify(msg))
    setMessages((m: string[]) => [...m, `Sent board move: ${sourceSquare} -> ${targetSquare}`])

    // Keep the board controlled by server state so rejected moves snap back cleanly.
    return false
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Realtime Chess</p>
          <h1>Lets play chess</h1>
        </div>
        <div className="status-pill">
          WebSocket: {connected ? 'connected' : 'disconnected'}
        </div>
      </header>

      {page === 'room' ? (
        <main className="page-grid room-page">
          <section className="panel hero-panel">
            <h2>Room</h2>
            <p className="panel-copy">
              Create a new room or join an existing one before jumping into the board.
            </p>
            <div className="action-stack">
              <button onClick={createRoom}>Create room</button>
              <div className="join-row">
                <input
                  placeholder="room id"
                  value={joinRoomInput}
                  onChange={(e) => setJoinRoomInput(e.target.value)}
                />
                <select value={joinRole} onChange={(e) => setJoinRole(e.target.value as PlayerRole)}>
                  <option value="white">white</option>
                  <option value="black">black</option>
                  <option value="spectator">spectator</option>
                </select>
                <button onClick={joinRoom} disabled={!joinRoomInput.trim()}>
                  Join room
                </button>
              </div>
            </div>
            {roomId && (
              <div className="room-summary">
                Active room: <strong>{roomId}</strong> {joined ? `(${currentRole})` : ''}
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Activity</h2>
            <div className="message-list">
              {messages.length === 0 && <div className="empty-state">No messages yet</div>}
              {messages.map((m, i) => (
                <div key={i} className="message-item">
                  {m}
                </div>
              ))}
            </div>
          </section>
        </main>
      ) : (
        <main className="page-grid game-page">
          <section className="panel board-panel">
            <div className="panel-header">
              <div>
                <h2>Game</h2>
                <p className="panel-copy">
                  Room <strong>{roomId ?? 'not joined'}</strong>
                  {currentRole ? ` • playing as ${currentRole}` : ''}
                </p>
              </div>
              <button type="button" className="secondary-button" onClick={() => { window.location.hash = '/room' }}>
                Back to room
              </button>
            </div>

            {resultCopy && (
              <div className="result-banner" role="status" aria-live="polite">
                <strong>{resultCopy.title}</strong>
                <span>{resultCopy.description}</span>
              </div>
            )}

            {roomState ? (
              <div className="board-wrap">
                <ChessboardWrapper
                  fen={roomState.board_fen}
                  allowDragging={connected && joined && currentRole !== 'spectator'}
                  onPieceDrop={({ sourceSquare, targetSquare }) => handleBoardMove(sourceSquare, targetSquare)}
                />
              </div>
            ) : (
              <div className="empty-board">Waiting for room state...</div>
            )}
          </section>

          <section className="panel side-panel">
            <h2>Match Info</h2>
            {roomState ? (
              <>
                <div className="stats-grid">
                  <div className="stat-card">
                    <span className="stat-label">Turn</span>
                    <strong>{roomState.result ? 'game over' : roomState.turn}</strong>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Moves</span>
                    <strong>{Array.isArray(roomState.moves) ? roomState.moves.length : 'n/a'}</strong>
                  </div>
                </div>
                <div className="stat-card result-card">
                  <span className="stat-label">Result</span>
                  <strong>{resultCopy ? resultCopy.title : 'Game in progress'}</strong>
                </div>
                <div className="fen-block">
                  <span className="stat-label">Board FEN</span>
                  <code>{roomState.board_fen}</code>
                </div>
                <details className="raw-json">
                  <summary>Raw JSON</summary>
                  <pre>{JSON.stringify(roomState, null, 2)}</pre>
                </details>
              </>
            ) : (
              <div className="empty-state">Join a room to load the board.</div>
            )}

            <div className="message-section">
              <h3>Activity</h3>
              <div className="message-list compact">
                {messages.length === 0 && <div className="empty-state">No messages yet</div>}
                {messages.map((m, i) => (
                  <div key={i} className="message-item">
                    {m}
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      )}
    </div>
  )
}

export default App
