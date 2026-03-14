import { useEffect, useRef, useState } from 'react'
import ChessboardWrapper from './ChessboardWrapper'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'

function App() {
  const [messages, setMessages] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)
  const [joinRoomInput, setJoinRoomInput] = useState<string>('')
  const [joinRole, setJoinRole] = useState<'white' | 'black' | 'spectator'>('white')
  const [roomState, setRoomState] = useState<any | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [moveInput, setMoveInput] = useState<string>('')

  useEffect(() => {
    // open websocket when component mounts
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    // connect to /ws on same host
    const url = `${protocol}://localhost:8000/ws`
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
          setJoined(true)
          setMessages((m: string[]) => [...m, `Joined room ${obj.room_id} as ${obj.role}`])
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
      } catch (e) {
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

  return (
    <div className="App">
      <div className="logo-row">
        <a href="https://vite.dev" target="_blank" rel="noreferrer">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank" rel="noreferrer">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>

  <h1>Lets play chess</h1>

        <div className="card">
        <div style={{ marginBottom: 12 }}>
          <button onClick={createRoom}>Create room</button>
          {roomId && (
            <span style={{ marginLeft: 12 }}>Room: <strong>{roomId}</strong> {joined ? '(joined)' : ''}</span>
          )}
        </div>
        <div style={{ marginBottom: 12, marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            placeholder="room id"
            value={joinRoomInput}
            onChange={(e) => setJoinRoomInput(e.target.value)}
            style={{ width: 160 }}
          />
          <select value={joinRole} onChange={(e) => setJoinRole(e.target.value as any)}>
            <option value="white">white</option>
            <option value="black">black</option>
            <option value="spectator">spectator</option>
          </select>
          <button
            onClick={() => {
              const ws = wsRef.current
              if (ws && ws.readyState === WebSocket.OPEN) {
                const msg = { type: 'join_room', room_id: joinRoomInput, payload: { role: joinRole } }
                ws.send(JSON.stringify(msg))
                setMessages((m: string[]) => [...m, `Sent join_room ${joinRoomInput} as ${joinRole}`])
              } else {
                setMessages((m: string[]) => [...m, 'WebSocket not connected'])
              }
            }}
          >
            Join
          </button>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            placeholder='move JSON e.g. {"from":"e2","to":"e4"}'
            value={moveInput}
            onChange={(e) => setMoveInput(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            onClick={() => {
              const ws = wsRef.current
              if (ws && ws.readyState === WebSocket.OPEN) {
                // expect the user to type a JSON string exactly in the envelope format
                try {
                  // validate JSON
                  JSON.parse(moveInput)
                  ws.send(moveInput)
                  setMessages((m: string[]) => [...m, `Sent move: ${moveInput}`])
                  setMoveInput('')
                } catch (e) {
                  setMessages((m: string[]) => [...m, `Invalid JSON: ${String(e)}`])
                }
              } else {
                setMessages((m: string[]) => [...m, 'WebSocket not connected'])
              }
            }}
          >
            Send Move
          </button>
        </div>

        <p>WebSocket: {connected ? 'connected' : 'disconnected'}</p>

        <div style={{ marginTop: 12 }}>
          <strong>Messages</strong>
          <div style={{ marginTop: 8 }}>
            {messages.length === 0 && <div style={{ color: '#666' }}>No messages yet</div>}
            {messages.map((m, i) => (
              <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid #eee' }}>
                {m}
              </div>
            ))}
          </div>
        </div>
        {roomState && (
          <div style={{ marginTop: 12, padding: 12, border: '1px solid #ddd', borderRadius: 6, background: '#fafafa' }}>
            <strong>Room State</strong>
            <div style={{ marginTop: 8, display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div>turn: {roomState.turn}</div>
                <div>moves: {Array.isArray(roomState.moves) ? roomState.moves.length : 'n/a'}</div>
                <div style={{ wordBreak: 'break-all' }}>board_fen: {roomState.board_fen}</div>
              </div>
              <div style={{ width: 360 }}>
                  {/* react-chessboard expects a FEN string via position prop */}
                  {/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */}
                  {/* @ts-ignore */}
                  <ChessboardWrapper fen={roomState.board_fen} />
              </div>
            </div>
            <details style={{ marginTop: 8 }}>
              <summary>Raw JSON</summary>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(roomState, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>

      <p className="read-the-docs">Edit <code>src/App.tsx</code> to modify this demo.</p>
    </div>
  )
}

export default App
