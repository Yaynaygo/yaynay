import { useEffect, useRef, useState } from 'react'

const SHOW_DELTA_MS = 15_000

/** Shows a balance and, for a few seconds after it changes, the signed difference. */
export function LiveAmount({ value, decimals = 2 }: { value: string | null; decimals?: number }) {
  const previous = useRef<number | null>(null)
  const [delta, setDelta] = useState<{ amount: number; at: number } | null>(null)

  useEffect(() => {
    if (value === null) return
    const current = Number(value)
    const prev = previous.current
    previous.current = current
    if (prev === null || Math.abs(current - prev) < 10 ** -decimals / 2) return
    setDelta({ amount: current - prev, at: Date.now() })
    const id = setTimeout(() => setDelta(null), SHOW_DELTA_MS)
    return () => clearTimeout(id)
  }, [value, decimals])

  if (value === null) return <span>…</span>
  return (
    <span>
      <span className={delta ? 'flash' : undefined}>{Number(value).toFixed(decimals)}</span>
      {delta && (
        <span className={delta.amount > 0 ? 'delta up' : 'delta down'}>
          {' '}
          ({delta.amount > 0 ? '+' : ''}
          {delta.amount.toFixed(decimals)})
        </span>
      )}
    </span>
  )
}
