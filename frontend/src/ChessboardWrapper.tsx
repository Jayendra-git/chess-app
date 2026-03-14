import React, { useEffect, useState } from 'react'

// This wrapper attempts to dynamically import `react-chessboard` at runtime.
// If the module is not installed the import will fail; we catch that and
// render a safe fallback (the raw FEN) instead of letting the app crash.
export default function ChessboardWrapper({ fen }: { fen: string }) {
  const [Comp, setComp] = useState<any | null>(null)
  const [err, setErr] = useState<any | null>(null)

  useEffect(() => {
    let mounted = true
    import('react-chessboard')
      .then((mod) => {
        if (!mounted) return
        // prefer default export, fall back to named export or module itself
        const C = mod.default || mod.Chessboard || mod
        setComp(() => C)
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

  // Render the dynamically loaded chessboard component. Most versions accept
  // a `position` prop with a FEN string.
  // @ts-ignore - dynamic import may be untyped in this repo
  return <Comp position={fen} />
}
