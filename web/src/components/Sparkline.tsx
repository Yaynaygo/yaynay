import { useEffect, useId, useState } from 'react'
import { fetchPriceHistory, type PricePoint } from '../lib/history'

/** Area chart of an outcome's price history; green when up over the window, red when down. */
export function Sparkline({
  tokenId,
  interval = '1w',
  height = 120,
  className = 'spark',
}: {
  tokenId: string
  interval?: '1d' | '1w' | '1m'
  height?: number
  className?: string
}) {
  const [points, setPoints] = useState<PricePoint[] | null>(null)
  const gradientId = useId()

  useEffect(() => {
    let cancelled = false
    fetchPriceHistory(tokenId, interval)
      .then((p) => !cancelled && setPoints(p))
      .catch(() => !cancelled && setPoints([]))
    return () => {
      cancelled = true
    }
  }, [tokenId, interval])

  const width = 400
  if (!points || points.length < 2) {
    return <svg className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" />
  }

  const ps = points.map((p) => p.p)
  const min = Math.min(...ps)
  const max = Math.max(...ps)
  const pad = Math.max(0.02, (max - min) * 0.15)
  const lo = Math.max(0, min - pad)
  const hi = Math.min(1, max + pad)
  const t0 = points[0].t
  const t1 = points[points.length - 1].t
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * width
  const y = (p: number) => height - ((p - lo) / Math.max(0.0001, hi - lo)) * (height - 6) - 3
  const line = points.map((pt, i) => `${i ? 'L' : 'M'}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  const up = ps[ps.length - 1] >= ps[0]
  const color = up ? 'var(--yes)' : 'var(--no)'

  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Price ${up ? 'up' : 'down'} from ${(ps[0] * 100).toFixed(0)}% to ${(ps[ps.length - 1] * 100).toFixed(0)}%`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={x(t1)} cy={y(ps[ps.length - 1])} r="3.5" fill={color} />
    </svg>
  )
}
