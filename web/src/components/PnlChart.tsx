import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { PnlPoint, PnlRange } from '../lib/dashboard'

const TOP = 14
const BOTTOM = 24

const money = (n: number) =>
  `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Hours when the series spans under a day and a half (a new account on 1W, or 1D), else dates. */
function tickLabel(t: number, span: number) {
  const d = new Date(t * 1000)
  return span < 36 * 3600
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: span < 6 * 3600 ? '2-digit' : undefined })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function whenLabel(t: number, range: PnlRange) {
  const d = new Date(t * 1000)
  return range === '1D' || range === '1W'
    ? d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Profit and loss over time. The line and its glow are mint above break-even and coral below it,
 * split exactly at zero. Hovering or dragging scrubs through the series and reports the point.
 */
export function PnlChart(props: {
  points: PnlPoint[]
  range: PnlRange
  height?: number
  onScrub?: (point: PnlPoint | null) => void
}) {
  const { points, range, onScrub } = props
  const height = props.height ?? 210
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    setWidth(Math.round(el.getBoundingClientRect().width))
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const geo = useMemo(() => {
    if (width === 0 || points.length < 2) return null
    const plotH = height - TOP - BOTTOM
    const t0 = points[0].t
    const t1 = points[points.length - 1].t
    const values = points.map((p) => p.p)
    let lo = Math.min(...values)
    let hi = Math.max(...values)
    // Keep break-even in view when the series comes near it, so the colour split means something.
    const span0 = Math.max(hi - lo, Math.abs(hi) * 0.02, 0.01)
    if (lo > 0 && lo < span0 * 1.5) lo = 0
    if (hi < 0 && -hi < span0 * 1.5) hi = 0
    const pad = Math.max((hi - lo) * 0.14, 0.01)
    lo -= pad
    hi += pad
    const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * width)
    const y = (p: number) => TOP + (1 - (p - lo) / (hi - lo)) * plotH
    const zeroY = Math.min(Math.max(y(0), TOP), TOP + plotH)
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join('')
    const area = `${line}L${x(t1).toFixed(1)},${zeroY.toFixed(1)}L0,${zeroY.toFixed(1)}Z`
    const ticks = width < 420 ? 3 : 4
    const tickTs = Array.from({ length: ticks }, (_, i) => t0 + ((t1 - t0) * (i + 0.5)) / ticks)
    return { x, y, zeroY, line, area, plotH, tickTs, zeroInView: y(0) >= TOP && y(0) <= TOP + plotH }
  }, [points, width, height])

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    if (!geo) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    let best = 0
    let bestD = Infinity
    points.forEach((p, i) => {
      const d = Math.abs(geo.x(p.t) - px)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    setHover(best)
    onScrub?.(points[best])
  }
  const leave = () => {
    setHover(null)
    onScrub?.(null)
  }

  const last = points[points.length - 1]
  const focus = hover !== null ? points[hover] : last
  const focusUp = (focus?.p ?? 0) >= 0
  const tipLeft = geo && focus ? geo.x(focus.t) > width * 0.62 : false

  return (
    <div
      ref={wrap}
      className="pnl-plot"
      style={{ height }}
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={leave}
      onPointerCancel={leave}
    >
      {geo && (
        <svg className="pnl-svg" width={width} height={height} role="img" aria-label={`Profit and loss, ${range}`}>
          <defs>
            <clipPath id={`up-${uid}`}>
              <rect x={0} y={0} width={width} height={geo.zeroY} />
            </clipPath>
            <clipPath id={`dn-${uid}`}>
              <rect x={0} y={geo.zeroY} width={width} height={height - geo.zeroY} />
            </clipPath>
            <linearGradient id={`gu-${uid}`} x1="0" x2="0" y1={TOP} y2={geo.zeroY} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--yes)" stopOpacity="0.32" />
              <stop offset="1" stopColor="var(--yes)" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`gd-${uid}`} x1="0" x2="0" y1={geo.zeroY} y2={TOP + geo.plotH} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--no)" stopOpacity="0.02" />
              <stop offset="1" stopColor="var(--no)" stopOpacity="0.3" />
            </linearGradient>
          </defs>

          {geo.zeroInView && (
            <g className="pnl-zero">
              <line x1={0} x2={width} y1={Math.round(geo.zeroY) + 0.5} y2={Math.round(geo.zeroY) + 0.5} />
              <text x={width - 4} y={geo.zeroY - 6} textAnchor="end">
                break-even
              </text>
            </g>
          )}

          <g key={`${range}-${points.length}`} className="pnl-draw">
            <path d={geo.area} fill={`url(#gu-${uid})`} clipPath={`url(#up-${uid})`} className="pnl-area" />
            <path d={geo.area} fill={`url(#gd-${uid})`} clipPath={`url(#dn-${uid})`} className="pnl-area" />
            <path d={geo.line} className="pnl-line up" clipPath={`url(#up-${uid})`} pathLength={1} />
            <path d={geo.line} className="pnl-line down" clipPath={`url(#dn-${uid})`} pathLength={1} />
          </g>

          {geo.tickTs.map((t) => (
            <text key={t} className="pnl-axis" x={geo.x(t)} y={height - 6} textAnchor="middle">
              {tickLabel(t, points[points.length - 1].t - points[0].t)}
            </text>
          ))}

          {hover !== null && focus && (
            <line className="pnl-cross" x1={geo.x(focus.t)} x2={geo.x(focus.t)} y1={TOP - 6} y2={TOP + geo.plotH} />
          )}
          {focus && (
            <g transform={`translate(${geo.x(focus.t)},${geo.y(focus.p)})`} className={`pnl-dot ${focusUp ? 'up' : 'down'}`}>
              {hover === null && <circle className="pnl-pulse" r="4" />}
              <circle r="4.5" />
            </g>
          )}
        </svg>
      )}
      {geo && hover !== null && focus && (
        <div className={`pnl-tip${tipLeft ? ' left' : ''}`} style={{ left: geo.x(focus.t), top: Math.max(4, geo.y(focus.p) - 46) }}>
          <b className={focusUp ? 'up' : 'down'}>{money(focus.p)}</b>
          <span>{whenLabel(focus.t, range)}</span>
        </div>
      )}
    </div>
  )
}
