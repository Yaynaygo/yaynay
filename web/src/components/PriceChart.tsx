import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { BRAND } from '../config'
import {
  CHART_RANGES,
  candleSeconds,
  fetchChartHistory,
  formatPct,
  fullTimeLabel,
  isShortRange,
  longerRange,
  nearestIndex,
  priceDomain,
  priceTicks,
  timeLabel,
  timeStep,
  timeTicks,
  toCandles,
  type Candle,
  type ChartRange,
  type PricePoint,
} from '../lib/chart'
import { Logo } from './Logo'
import '../styles/chart.css'

export type { ChartRange }
export type ChartSeries = { tokenId: string; label: string; color?: string }
type Mode = 'line' | 'candles'

// Multi-outcome palette: distinct hues that do not read as yes/no.
const PALETTE = ['var(--yes)', '#7c5cff', '#f0a020', '#2b9bd8']
const AXIS_W = 48 // right-hand price axis
const X_AXIS_H = 24 // bottom time axis
const TOP = 10 // headroom above the plot
const INSET_R = 12 // keeps the last-value dot clear of the axis
const REFRESH_MS = 60_000
const TAG_H = 18

type Fetched = { key: string; points: PricePoint[][] | null; error: string | null }
type Line = { tokenId: string; label: string; color: string; points: PricePoint[]; ts: number[] }

/** Main market chart: line or candles, range pills, crosshair scrubbing and multi-outcome legend. */
export function PriceChart({
  series,
  height = 280,
  defaultRange = '1W',
  defaultMode = 'line',
  onRangeChange,
  onModeChange,
  livePrice,
}: {
  series: ChartSeries[]
  height?: number
  defaultRange?: ChartRange
  /** Initial chart type; candles only apply to a single series. */
  defaultMode?: 'line' | 'candles'
  onRangeChange?: (r: ChartRange) => void
  onModeChange?: (mode: 'line' | 'candles') => void
  /** Current price from the live feed; on short ranges it extends a single series' last point so the line moves. */
  livePrice?: number
}) {
  const [range, setRange] = useState<ChartRange>(defaultRange)
  const [mode, setMode] = useState<Mode>(defaultMode)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [reload, setReload] = useState(0)
  const [fetched, setFetched] = useState<Fetched | null>(null)
  const [width, setWidth] = useState(0)
  const plotRef = useRef<HTMLDivElement>(null)
  const gradientId = `pc-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  const single = series.length === 1
  const effMode: Mode = single ? mode : 'line'
  const tokensKey = series.map((s) => s.tokenId).join(',')
  const key = `${tokensKey}|${range}|${reload}`

  // Load every series for the range; stale requests are aborted and short ranges refresh quietly.
  useEffect(() => {
    const tokens = tokensKey ? tokensKey.split(',') : []
    const ctrl = new AbortController()
    const load = (fresh: boolean) =>
      Promise.all(tokens.map((t) => fetchChartHistory(t, range, { signal: ctrl.signal, fresh })))
    const thisKey = `${tokensKey}|${range}|${reload}`
    load(reload > 0)
      .then((points) => !ctrl.signal.aborted && setFetched({ key: thisKey, points, error: null }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setFetched({ key: thisKey, points: null, error: e instanceof Error ? e.message : 'Price history unavailable' })
      })
    const timer = isShortRange(range)
      ? setInterval(() => {
          if (document.hidden) return
          load(true)
            .then((points) => !ctrl.signal.aborted && setFetched((f) => (f?.key === thisKey ? { ...f, points, error: null } : f)))
            .catch(() => {}) // keep showing the last good data
        }, REFRESH_MS)
      : undefined
    return () => {
      ctrl.abort()
      clearInterval(timer)
    }
  }, [tokensKey, range, reload])

  // Track the real pixel width so nothing gets stretched.
  useLayoutEffect(() => {
    const el = plotRef.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const current = fetched?.key === key ? fetched : null
  const loading = !current
  const error = current?.error ?? null
  const fetchedPoints = current?.points ?? null
  // Live tail: on short ranges the single series gets a point at the time the live price last changed.
  const [tail, setTail] = useState<{ t: number; p: number } | null>(null)
  const liveOk = single && isShortRange(range) && livePrice !== undefined && Number.isFinite(livePrice)
  useEffect(() => {
    // Stamped on the next frame, which also coalesces bursts of price changes.
    const frame = requestAnimationFrame(() => setTail(liveOk ? { t: Math.floor(Date.now() / 1000), p: livePrice } : null))
    return () => cancelAnimationFrame(frame)
  }, [liveOk, livePrice])
  const allPoints = useMemo(() => {
    const pts = fetchedPoints?.[0]
    if (!fetchedPoints || !tail || !liveOk || !pts?.length || tail.t <= pts[pts.length - 1].t) return fetchedPoints
    return [[...pts, tail], ...fetchedPoints.slice(1)]
  }, [fetchedPoints, tail, liveOk])

  const lines: Line[] = useMemo(() => {
    if (!allPoints) return []
    return series
      .map((s, i) => {
        const points = allPoints[i] ?? []
        return { tokenId: s.tokenId, label: s.label, color: s.color ?? PALETTE[i % PALETTE.length], points, ts: points.map((p) => p.t) }
      })
      .filter((l) => !hidden.has(l.tokenId))
  }, [allPoints, series, hidden])

  const enough = !!allPoints && allPoints.some((p) => p.length >= 2)
  const primary = useMemo(() => lines.find((l) => l.points.length > 0) ?? null, [lines])

  // Single-series direction over the window decides mint vs coral.
  const first = single && primary ? primary.points[0].p : null
  const last = single && primary ? primary.points[primary.points.length - 1].p : null
  const up = first === null || last === null || last >= first
  const trendColor = up ? 'var(--yes)' : 'var(--no)'

  const candles: { list: Candle[]; bucket: number } | null = useMemo(() => {
    if (effMode !== 'candles' || !primary) return null
    const pts = primary.points
    const bucket = candleSeconds(range, pts[pts.length - 1].t - pts[0].t)
    return { list: toCandles(pts, bucket), bucket }
  }, [effMode, primary, range])

  // ---------- geometry ----------
  const plotRight = Math.max(0, width - AXIS_W)
  const xMax = plotRight - INSET_R
  const geo = useMemo(() => {
    let t0 = Infinity
    let t1 = -Infinity
    const values: number[] = []
    if (candles && candles.list.length) {
      t0 = candles.list[0].t
      t1 = candles.list[candles.list.length - 1].t + candles.bucket
      for (const c of candles.list) values.push(c.h, c.l)
    } else {
      for (const l of lines) {
        if (!l.points.length) continue
        t0 = Math.min(t0, l.points[0].t)
        t1 = Math.max(t1, l.points[l.points.length - 1].t)
        for (const p of l.points) values.push(p.p)
      }
    }
    if (!Number.isFinite(t0)) return null
    if (t1 <= t0) t1 = t0 + 1
    const [lo, hi] = priceDomain(values)
    return { t0, t1, lo, hi }
  }, [candles, lines])

  const x = (t: number) => (geo ? 2 + ((t - geo.t0) / (geo.t1 - geo.t0)) * (xMax - 2) : 0)
  const y = (p: number) => (geo ? TOP + (1 - (p - geo.lo) / (geo.hi - geo.lo)) * height : 0)
  const tAt = (px: number) => (geo ? geo.t0 + ((px - 2) / Math.max(1, xMax - 2)) * (geo.t1 - geo.t0) : 0)

  // Crosshair stops: candle centres or the primary series' timestamps.
  const stops: number[] = useMemo(() => {
    if (candles) return candles.list.map((c) => c.t + candles.bucket / 2)
    return primary?.ts ?? []
  }, [candles, primary])
  const hoverIdx = hoverT === null ? -1 : nearestIndex(stops, hoverT)
  const crossT = hoverIdx >= 0 ? stops[hoverIdx] : null
  const hoverCandle = candles && hoverIdx >= 0 ? candles.list[hoverIdx] : null
  const valueAt = (l: Line, t: number | null) => {
    if (!l.points.length) return null
    if (t === null) return l.points[l.points.length - 1]
    return l.points[nearestIndex(l.ts, t)]
  }

  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    if (!geo || !enough) return
    const rect = e.currentTarget.getBoundingClientRect()
    setHoverT(tAt(e.clientX - rect.left))
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      setHoverT(null)
      return
    }
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !stops.length) return
    e.preventDefault()
    const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)
    const from = hoverIdx >= 0 ? hoverIdx : step < 0 ? stops.length : -1
    setHoverT(stops[Math.min(stops.length - 1, Math.max(0, from + step))])
  }

  const pickRange = (r: ChartRange) => {
    setRange(r)
    setHoverT(null)
    onRangeChange?.(r)
  }
  const toggle = (tokenId: string) =>
    setHidden((h) => {
      const next = new Set(h)
      if (next.has(tokenId)) next.delete(tokenId)
      else if (series.filter((s) => !next.has(s.tokenId)).length > 1) next.add(tokenId) // keep at least one line
      return next
    })

  // ---------- header ----------
  const headline = (() => {
    if (!single) {
      return (
        <div className="pc-legend">
          {series.map((s, i) => {
            const line = lines.find((l) => l.tokenId === s.tokenId)
            const pt = line ? valueAt(line, crossT) : null
            const off = hidden.has(s.tokenId)
            return (
              <button key={s.tokenId} type="button" className={`pc-chip${off ? ' pc-chip-off' : ''}`} aria-pressed={!off} onClick={() => toggle(s.tokenId)}>
                <span className="pc-dot" style={{ background: s.color ?? PALETTE[i % PALETTE.length] }} />
                <span className="pc-chip-label">{s.label}</span>
                <span className="pc-chip-value">{loading ? '—' : pt ? formatPct(pt.p) : off ? '' : '—'}</span>
              </button>
            )
          })}
        </div>
      )
    }
    if (loading) return <div className="pc-headline"><span className="pc-skel-bar" /></div>
    const shown = primary ? (hoverCandle ? hoverCandle.c : valueAt(primary, crossT)?.p ?? null) : null
    const delta = first !== null && last !== null ? (last - first) * 100 : null
    return (
      <div className="pc-headline">
        {shown !== null && (
          <div className="pc-big">
            <span className="pc-big-value">{formatPct(shown)}</span>
            <span className="pc-big-unit">chance</span>
          </div>
        )}
        {delta !== null && enough && (
          <div className={`pc-delta ${Math.abs(delta) < 0.05 ? 'pc-flat' : delta > 0 ? 'pc-up' : 'pc-down'}`}>
            {Math.abs(delta) < 0.05 ? '–' : delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)} pts · {range}
          </div>
        )}
      </div>
    )
  })()

  const controls = (
    <div className="pc-controls">
      <div className="pc-seg" role="group" aria-label="Time range">
        {CHART_RANGES.map((r) => (
          <button key={r} type="button" className="pc-seg-btn" aria-pressed={r === range} onClick={() => pickRange(r)}>
            {r}
          </button>
        ))}
      </div>
      {single && (
        <div className="pc-seg" role="group" aria-label="Chart type">
          <button type="button" className="pc-seg-btn" aria-pressed={mode === 'line'} onClick={() => setMode('line')} title="Line">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M1 10l3.5-4 3 2.5L13 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="pc-sr">Line</span>
          </button>
          <button type="button" className="pc-seg-btn" aria-pressed={mode === 'candles'} onClick={() => {
              setMode('candles')
              onModeChange?.('candles')
            }} title="Candles">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M4 1.5v11M10 3v9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <rect x="2.4" y="3.5" width="3.2" height="6" rx="0.8" fill="currentColor" />
              <rect x="8.4" y="5" width="3.2" height="4.5" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.1" />
            </svg>
            <span className="pc-sr">Candles</span>
          </button>
        </div>
      )}
    </div>
  )

  // ---------- plot ----------
  const svgH = TOP + height + X_AXIS_H
  const ready = !loading && !error && enough && geo && width > 0

  let body: ReactNode = null
  let tooltip: ReactNode = null
  let summary = ''
  let readout = ''
  if (ready && geo) {
    const yTicks = priceTicks(geo.lo, geo.hi)
    const span = geo.t1 - geo.t0
    const maxXTicks = Math.max(2, Math.min(6, Math.floor(xMax / 90) + 1))
    const xTicks = timeTicks(geo.t0, geo.t1, maxXTicks)
    const xStep = timeStep(geo.t0, geo.t1, maxXTicks)

    // Last-value tags on the axis, nudged apart so they never overlap.
    const tags = (candles
      ? (() => {
          const lc = candles.list[candles.list.length - 1]
          return lc ? [{ id: 'c', p: lc.c, color: lc.c >= lc.o ? 'var(--yes)' : 'var(--no)', filled: true }] : []
        })()
      : lines
          .filter((l) => l.points.length)
          .map((l) => ({ id: l.tokenId, p: l.points[l.points.length - 1].p, color: single ? trendColor : l.color, filled: single }))
    )
      .map((t) => ({ ...t, y: y(t.p) }))
      .sort((a, b) => a.y - b.y)
    for (let i = 1; i < tags.length; i++) tags[i].y = Math.max(tags[i].y, tags[i - 1].y + TAG_H + 2)
    const clashes = (ty: number) => tags.some((t) => Math.abs(t.y - ty) < TAG_H - 2)

    const lineFor = (pts: PricePoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join('')

    let marks: ReactNode
    if (candles) {
      const slot = (xMax - 2) * (candles.bucket / span)
      let bw = Math.max(1, Math.min(13, Math.floor(slot * 0.64)))
      if (bw % 2 === 0) bw -= 1
      marks = (
        <g className="pc-candles" shapeRendering="crispEdges">
          {candles.list.map((c, i) => {
            const cx = Math.round(x(c.t + candles.bucket / 2))
            const top = Math.round(y(Math.max(c.o, c.c)))
            const bot = Math.round(y(Math.min(c.o, c.c)))
            const col = c.c > c.o ? 'var(--yes)' : c.c < c.o ? 'var(--no)' : 'var(--muted)'
            const dim = hoverIdx >= 0 && hoverIdx !== i
            return (
              <g key={c.t} opacity={dim ? 0.55 : 1}>
                <line x1={cx + 0.5} x2={cx + 0.5} y1={Math.round(y(c.h))} y2={Math.round(y(c.l))} stroke={col} strokeWidth="1" />
                <rect x={cx - (bw - 1) / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={col} />
              </g>
            )
          })}
        </g>
      )
    } else {
      marks = (
        <>
          {single && primary && primary.points.length >= 2 && (
            <>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={trendColor} stopOpacity="0.2" />
                  <stop offset="1" stopColor={trendColor} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d={`${lineFor(primary.points)}L${x(primary.points[primary.points.length - 1].t).toFixed(1)},${TOP + height}L${x(primary.points[0].t).toFixed(1)},${TOP + height}Z`}
                fill={`url(#${gradientId})`}
              />
            </>
          )}
          {lines.map((l) => (
            <path
              key={l.tokenId}
              d={lineFor(l.points)}
              fill="none"
              stroke={single ? trendColor : l.color}
              strokeWidth={single ? 2 : 1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {lines
            .filter((l) => l.points.length)
            .map((l) => {
              const lp = l.points[l.points.length - 1]
              const col = single ? trendColor : l.color
              return (
                <g key={l.tokenId} transform={`translate(${x(lp.t).toFixed(1)} ${y(lp.p).toFixed(1)})`}>
                  <circle className="pc-pulse" r="3.5" fill={col} />
                  <circle r="3.5" fill={col} stroke="var(--surface)" strokeWidth="1.5" />
                </g>
              )
            })}
        </>
      )
    }

    const guideP = candles ? candles.list[candles.list.length - 1]?.c : single ? last : null
    body = (
      <svg className="pc-svg" width={width} height={svgH} aria-hidden="true">
        {yTicks.map((p) => (
          <g key={p}>
            <line className="pc-grid" x1={0} x2={plotRight} y1={Math.round(y(p)) + 0.5} y2={Math.round(y(p)) + 0.5} />
            {!clashes(y(p)) && (
              <text className="pc-axis" x={plotRight + 8} y={y(p)} dy="0.35em">
                {formatPct(p, Math.abs(p * 100 - Math.round(p * 100)) < 1e-6 ? 0 : 1)}
              </text>
            )}
          </g>
        ))}
        {xTicks.map((t) => {
          const tx = x(t)
          if (tx < 18 || tx > xMax - 14) return null
          return (
            <text key={t} className="pc-axis" x={tx} y={TOP + height + 17} textAnchor="middle">
              {timeLabel(t, xStep)}
            </text>
          )
        })}
        {guideP !== null && guideP !== undefined && (
          <line className="pc-guide" x1={0} x2={plotRight} y1={y(guideP)} y2={y(guideP)} stroke={tags[0]?.color} />
        )}
        {marks}
        {crossT !== null && (
          <g className="pc-cross">
            <line x1={Math.round(x(crossT)) + 0.5} x2={Math.round(x(crossT)) + 0.5} y1={TOP} y2={TOP + height} />
            {!candles &&
              lines.map((l) => {
                const pt = valueAt(l, crossT)
                return pt ? <circle key={l.tokenId} cx={x(pt.t)} cy={y(pt.p)} r="4" fill={single ? trendColor : l.color} stroke="var(--surface)" strokeWidth="2" /> : null
              })}
          </g>
        )}
        {tags.map((t) => (
          <g key={t.id} transform={`translate(${plotRight + 3} ${(t.y - TAG_H / 2).toFixed(1)})`}>
            <rect
              width={AXIS_W - 5}
              height={TAG_H}
              rx="5"
              fill={t.filled ? t.color : 'var(--surface)'}
              stroke={t.color}
              strokeWidth={t.filled ? 0 : 1.25}
            />
            <text className="pc-tag-text" x={(AXIS_W - 5) / 2} y={TAG_H / 2} dy="0.35em" textAnchor="middle" fill={t.filled ? 'var(--ink-text)' : t.color}>
              {formatPct(t.p)}
            </text>
          </g>
        ))}
      </svg>
    )

    if (crossT !== null) {
      const cx = x(crossT)
      const left = cx > plotRight / 2
      const rows = hoverCandle
        ? [
            ['Open', hoverCandle.o],
            ['High', hoverCandle.h],
            ['Low', hoverCandle.l],
            ['Close', hoverCandle.c],
          ].map(([k, v]) => ({ key: String(k), label: String(k), color: null as string | null, value: formatPct(v as number, 1) }))
        : lines.map((l) => {
            const pt = valueAt(l, crossT)
            return { key: l.tokenId, label: l.label, color: single ? trendColor : l.color, value: pt ? formatPct(pt.p, 1) : '—' }
          })
      const when = hoverCandle ? fullTimeLabel(hoverCandle.t) : fullTimeLabel(crossT)
      tooltip = (
        <div className={`pc-tip${left ? ' pc-tip-left' : ''}`} style={{ left: cx, top: TOP + 4 }}>
          <div className="pc-tip-time">{when}</div>
          {rows.map((r) => (
            <div key={r.key} className="pc-tip-row">
              {r.color && <span className="pc-dot" style={{ background: r.color }} />}
              <span className="pc-tip-label">{r.label}</span>
              <span className="pc-tip-value">{r.value}</span>
            </div>
          ))}
        </div>
      )
      readout = `${when}: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}`
    }

    if (single && primary && first !== null && last !== null) {
      const ps = primary.points.map((p) => p.p)
      summary = `${primary.label} chance over ${range}: ${formatPct(first)} to ${formatPct(last)}, high ${formatPct(Math.max(...ps))}, low ${formatPct(Math.min(...ps))}.`
    } else {
      summary = `Chances over ${range}: ${lines.map((l) => `${l.label} ${l.points.length ? formatPct(l.points[l.points.length - 1].p) : 'no data'}`).join(', ')}.`
    }
    summary += ' Use the left and right arrow keys to inspect values.'
  }

  const next = longerRange(range)
  return (
    <div className="pc">
      <div className="pc-head">
        {headline}
        {controls}
      </div>
      <div
        ref={plotRef}
        className={`pc-plot${ready ? ' pc-plot-ready' : ''}`}
        style={{ height: svgH }}
        tabIndex={ready ? 0 : -1}
        role="group"
        aria-roledescription="chart"
        aria-label={ready ? summary : loading ? 'Loading chart' : 'Chart'}
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => setHoverT(null)}
        onKeyDown={onKey}
        onBlur={() => setHoverT(null)}
      >
        {loading && <div className="pc-skeleton" style={{ height: TOP + height }} aria-hidden="true" />}
        {!loading && error && (
          <div className="pc-state" style={{ height: TOP + height }}>
            <p>Couldn't load the price history.</p>
            <button type="button" className="pc-state-btn" onClick={() => setReload((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {!loading && !error && !enough && (
          <div className="pc-state" style={{ height: TOP + height }}>
            <p>No trades in this window yet</p>
            {next && (
              <button type="button" className="pc-state-btn" onClick={() => pickRange(next)}>
                Show {next}
              </button>
            )}
          </div>
        )}
        {body}
        {tooltip}
        {ready && (
          <div className="pc-watermark" style={{ bottom: X_AXIS_H + 8 }} aria-hidden="true">
            <Logo size={18} />
            <span>{BRAND.name}</span>
          </div>
        )}
        <div className="pc-sr" aria-live="polite">
          {readout}
        </div>
      </div>
    </div>
  )
}
