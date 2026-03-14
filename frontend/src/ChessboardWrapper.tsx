import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import type { ChessboardOptions } from 'react-chessboard'

// This wrapper attempts to dynamically import `react-chessboard` at runtime.
// If the module is not installed the import will fail; we catch that and
// render a safe fallback (the raw FEN) instead of letting the app crash.
type ChessboardWrapperProps = {
  fen: string
  allowDragging?: boolean
  onPieceDrop?: ChessboardOptions['onPieceDrop']
}

export default function ChessboardWrapper({
  fen,
  allowDragging = true,
  onPieceDrop,
}: ChessboardWrapperProps) {
  const [Comp, setComp] = useState<ComponentType<{ options?: ChessboardOptions }> | null>(null)
  const [err, setErr] = useState<any | null>(null)

  useEffect(() => {
    let mounted = true
    import('react-chessboard')
      .then((mod) => {
        if (!mounted) return
        setComp(() => mod.Chessboard)
      })
      .catch((e) => {
        if (!mounted) return
        console.warn('react-chessboard import failed:', e)
        setErr(e)
      })
    return () => {
      mounted = false
    }
  }, [])

  if (err) {
    return (
      <div style={{ padding: 8, border: '1px dashed #ccc', borderRadius: 4 }}>
        <div style={{ color: '#900', marginBottom: 6 }}>Board library not available.</div>
        <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{fen}</div>
      </div>
    )
  }

  if (!Comp) {
    return <div>Loading board...</div>
  }

  return <Comp options={{ position: fen, allowDragging, onPieceDrop }} />
}
