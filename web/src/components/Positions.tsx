import { useEffect, useMemo, useState } from 'react'
import { listPositions, type Position } from '../lib/markets'
import { quoteSell, sellPosition } from '../lib/sellPosition'
import type { PolyClient } from '../lib/polyAccount'
import { track } from '../lib/progress'
import { routeHref } from '../lib/router'
import type { BalanceDelta } from '../lib/balanceHint'

type RowStatus = { text: string; error?: boolean }

// Expected size after a sell or redeem, shown until the Data API catches up (or the hold expires).
type Pending = { size: number; until: number }
const PENDING_MS = 60_000

export function Positions(props: {
  client: PolyClient
  /** 1-click trading session client; orders signed without wallet prompts when set. */
  tradeClient: PolyClient | null
  wallet: string
  refreshKey: number
  onPolygon: () => Promise<void>
  onChanged: (delta?: BalanceDelta) => void
  /** Trading balance before a sell or claim lands, for the optimistic update. */
  pusdBalance?: string | null
  onTotals?: (totals: { value: number; pnl: number; count: number }) => void
}) {
  const [positions, setPositions] = useState<Position[]>([])
  const [loadError, setLoadError] = useState('')
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, Pending>>({})
  // Display only: hides the empty state until the first response arrives.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const load = () =>
      listPositions(props.wallet)
        .then((p) => {
          setPositions(p)
          setLoaded(true)
          setLoadError('')
          // Drop optimistic values once the API reports the new size (or the hold expires).
          setPending((prev) => {
            const next: Record<string, Pending> = {}
            for (const [asset, pend] of Object.entries(prev)) {
              const live = p.find((x) => x.asset === asset)?.size ?? 0
              if (Date.now() < pend.until && Math.abs(live - pend.size) > 0.01) next[asset] = pend
            }
            return next
          })
        })
        .catch((e) => {
          setLoaded(true)
          setLoadError(String(e))
        })
    load()
    const id = setInterval(load, 20_000)
    return () => clearInterval(id)
  }, [props.wallet, props.refreshKey])

  const setStatus = (asset: string, status: RowStatus) => setRowStatus((prev) => ({ ...prev, [asset]: status }))

  async function sellAll(p: Position) {
    setBusy(p.asset)
    try {
      setStatus(p.asset, { text: 'Checking the order book…' })
      const quote = await quoteSell(p)
      if (!quote) {
        setStatus(p.asset, {
          text: 'No buyers for this outcome right now, so it cannot be sold. You can hold it until the market resolves.',
          error: true,
        })
        return
      }
      const before = props.pusdBalance ?? null
      const res = await sellPosition(p, quote, {
        client: props.client,
        tradeClient: props.tradeClient,
        onPolygon: props.onPolygon,
        onStatus: (text) => setStatus(p.asset, { text }),
      })
      setStatus(p.asset, { text: `Sold: ${res.sold} shares for ${res.received} pUSD.` })
      track('sell_done')
      const remaining = Math.max(0, p.size - res.sold)
      setPending((prev) => ({ ...prev, [p.asset]: { size: remaining, until: Date.now() + PENDING_MS } }))
      props.onChanged(res.received > 0 ? { pusd: { delta: res.received, before } } : undefined)
    } catch (e) {
      setStatus(p.asset, { text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function redeemPosition(p: Position) {
    setBusy(p.asset)
    try {
      await props.onPolygon()
      setStatus(p.asset, { text: 'Sign the redemption in your wallet (gasless)…' })
      const { redeem } = await import('../lib/trade')
      await redeem(props.client, p.conditionId)
      setStatus(p.asset, { text: 'Redeemed.' })
      track('claim_done')
      setPending((prev) => ({ ...prev, [p.asset]: { size: 0, until: Date.now() + PENDING_MS } }))
      props.onChanged(p.currentValue > 0 ? { pusd: { delta: p.currentValue, before: props.pusdBalance ?? null } } : undefined)
    } catch (e) {
      setStatus(p.asset, { text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  const shown = positions
    .map((p) => {
      const pend = pending[p.asset]
      if (!pend || Date.now() >= pend.until) return { ...p, updating: false }
      const ratio = p.size > 0 ? pend.size / p.size : 0
      return {
        ...p,
        size: pend.size,
        currentValue: pend.size * p.curPrice,
        cashPnl: p.cashPnl * ratio,
        updating: true,
      }
    })
    // Keep a fully closed row visible only while its status message explains what happened.
    .filter((p) => p.size >= 0.01 || (p.updating && rowStatus[p.asset]))

  const { onTotals } = props
  const totalValue = shown.reduce((sum, p) => sum + p.currentValue, 0)
  const totalPnl = shown.reduce((sum, p) => sum + p.cashPnl, 0)
  useEffect(() => {
    onTotals?.({ value: totalValue, pnl: totalPnl, count: shown.length })
  }, [onTotals, totalValue, totalPnl, shown.length])

  return (
    <PositionsBoard
      positions={shown}
      loaded={loaded}
      loadError={loadError}
      rowStatus={rowStatus}
      busy={busy}
      onSell={sellAll}
      onClaim={redeemPosition}
    />
  )
}

/* ---------- presentation ---------- */

export type ShownPosition = Position & { updating: boolean }
type Filter = 'all' | 'open' | 'claim'
type SortKey = 'value' | 'pnl' | 'move'

const usd = (n: number) => `$${Math.abs(n).toFixed(2)}`
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${usd(n)}`
const pct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)}%`
const priceCents = (p: number) => `${(p * 100).toFixed(p > 0 && p < 0.1 ? 1 : 0)}¢`

export function outcomeTone(outcome: string) {
  return /^(yes|up)$/i.test(outcome) ? 'yes' : /^(no|down)$/i.test(outcome) ? 'no' : 'neutral'
}

/** Three little candles: the empty-state mark. */
export function CandleArt({ size = 72 }: { size?: number }) {
  return (
    <svg className="pf-art" width={size} height={size} viewBox="0 0 72 72" aria-hidden="true">
      <path className="pf-art-base" d="M8 62h56" />
      <g className="pf-art-up">
        <path d="M18 18v38" />
        <rect x="12" y="26" width="12" height="22" rx="3" />
      </g>
      <g className="pf-art-down">
        <path d="M36 28v30" />
        <rect x="30" y="34" width="12" height="16" rx="3" />
      </g>
      <g className="pf-art-up">
        <path d="M54 8v42" />
        <rect x="48" y="14" width="12" height="26" rx="3" />
      </g>
    </svg>
  )
}

/** Where the money sits: one segment per position, mint when in profit, coral when down. */
export function AllocationBar({ positions }: { positions: ShownPosition[] }) {
  const [active, setActive] = useState<string | null>(null)
  const parts = positions.filter((p) => p.currentValue > 0.005).sort((a, b) => b.currentValue - a.currentValue)
  const total = parts.reduce((sum, p) => sum + p.currentValue, 0)
  if (parts.length === 0 || total <= 0) return null
  const up = parts.filter((p) => p.cashPnl >= 0).reduce((sum, p) => sum + p.currentValue, 0)
  const focus = parts.find((p) => p.asset === active)

  return (
    <div className="pf-alloc">
      <div className="pf-alloc-bar" onMouseLeave={() => setActive(null)}>
        {parts.map((p) => (
          <span
            key={p.asset}
            tabIndex={0}
            role="img"
            aria-label={`${p.title}, ${p.outcome}: ${usd(p.currentValue)}, ${Math.round((p.currentValue / total) * 100)}% of positions`}
            className={`pf-seg ${p.cashPnl >= 0 ? 'up' : 'down'}${active && active !== p.asset ? ' dim' : ''}`}
            style={{ flexGrow: p.currentValue }}
            onMouseEnter={() => setActive(p.asset)}
            onFocus={() => setActive(p.asset)}
            onBlur={() => setActive(null)}
          />
        ))}
      </div>
      <div className="pf-alloc-legend num" aria-live="polite">
        {focus ? (
          <>
            <span className="pf-alloc-name">
              <i className={`pf-key ${focus.cashPnl >= 0 ? 'up' : 'down'}`} />
              {focus.title} · {focus.outcome}
            </span>
            <span>
              <b>{usd(focus.currentValue)}</b> · {Math.round((focus.currentValue / total) * 100)}%
            </span>
          </>
        ) : (
          <>
            <span>
              <i className="pf-key up" /> In profit <b>{usd(up)}</b>
            </span>
            <span>
              <i className="pf-key down" /> Down <b>{usd(total - up)}</b>
            </span>
            <span className="pf-alloc-hint">Hover a slice for details</span>
          </>
        )}
      </div>
    </div>
  )
}

/** Bought-at and now on a 0–100¢ track, drawn as a candle body between them. */
function OddsMove({ from, to }: { from: number; to: number }) {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const diff = to - from
  const dir = Math.abs(diff) < 0.005 ? 'flat' : diff > 0 ? 'up' : 'down'
  return (
    <div className="pf-odds" title={`Bought at ${priceCents(from)}, now ${priceCents(to)}`}>
      <div className="pf-odds-line num">
        <span className="muted">{priceCents(from)}</span>
        <span aria-hidden="true">→</span>
        <b>{priceCents(to)}</b>
        <span className={`pf-move ${dir}`}>
          {dir === 'flat' ? 'flat' : `${dir === 'up' ? '▲' : '▼'} ${Math.abs(diff * 100).toFixed(Math.abs(diff) < 0.1 ? 1 : 0)}¢`}
        </span>
      </div>
      <div className="pf-track" aria-hidden="true">
        <span className={`pf-body ${dir}`} style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
        <span className={`pf-now ${dir}`} style={{ left: `${to * 100}%` }} />
      </div>
    </div>
  )
}

export function PositionRow(props: {
  p: ShownPosition
  status?: RowStatus
  busy: string | null
  onSell: (p: ShownPosition) => void
  onClaim: (p: ShownPosition) => void
}) {
  const { p, status, busy } = props
  const tone = outcomeTone(p.outcome)
  const cost = p.currentValue - p.cashPnl
  const won = p.redeemable && p.currentValue > 0.005
  const lost = p.redeemable && !won
  return (
    <li className={`pf-pos${won ? ' won' : ''}${lost ? ' lost' : ''}${p.updating ? ' updating' : ''}`}>
      <div className="pf-pos-main">
        <div className="pf-pos-title">
          {p.eventSlug ? <a href={routeHref({ name: 'market', slug: p.eventSlug })}>{p.title}</a> : <span>{p.title}</span>}
        </div>
        <div className="pf-pos-meta num">
          <span className={`badge ${tone}`}>{p.outcome}</span>
          <span>
            <b>{p.size.toFixed(2)}</b> shares
          </span>
          {!p.redeemable && (
            <span>
              pays <b>{usd(p.size)}</b> if right
            </span>
          )}
          {won && <span className="pf-chip claim">Ready to claim</span>}
          {lost && <span className="pf-chip">Resolved · didn't hit</span>}
          {p.updating && <span className="pf-chip wait">Updating…</span>}
        </div>
      </div>
      <OddsMove from={p.avgPrice} to={p.curPrice} />
      <div className="pf-pos-value num">
        <b>{usd(p.currentValue)}</b>
        <span className={p.cashPnl >= 0 ? 'up' : 'down'}>
          {signed(p.cashPnl)}
          {cost > 0.005 && <small> · {pct(p.cashPnl / cost)}</small>}
        </span>
      </div>
      <div className="pf-pos-act">
        {p.size < 0.01 ? null : p.redeemable ? (
          <button className={won ? 'yes' : 'subtle'} disabled={busy !== null} onClick={() => props.onClaim(p)}>
            {busy === p.asset ? 'Working…' : won ? `Claim ${usd(p.currentValue)}` : 'Clear'}
          </button>
        ) : (
          <button className="ghost" disabled={busy !== null} onClick={() => props.onSell(p)}>
            {busy === p.asset ? 'Working…' : 'Cash out'}
          </button>
        )}
      </div>
      {status && <p className={`pf-pos-status ${status.error ? 'error' : 'muted'}`}>{status.text}</p>}
    </li>
  )
}

/** The positions card: allocation, filter, sort and rows. Holds no money logic. */
export function PositionsBoard(props: {
  positions: ShownPosition[]
  loaded: boolean
  loadError: string
  rowStatus: Record<string, RowStatus>
  busy: string | null
  onSell: (p: ShownPosition) => void
  onClaim: (p: ShownPosition) => void
}) {
  const { positions } = props
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<SortKey>('value')
  const counts = {
    all: positions.length,
    open: positions.filter((p) => !p.redeemable).length,
    claim: positions.filter((p) => p.redeemable).length,
  }
  const rows = useMemo(() => {
    const list = positions.filter((p) => (filter === 'all' ? true : filter === 'claim' ? p.redeemable : !p.redeemable))
    const key = (p: ShownPosition) => (sort === 'value' ? p.currentValue : sort === 'pnl' ? p.cashPnl : p.curPrice - p.avgPrice)
    return [...list].sort((a, b) => key(b) - key(a))
  }, [positions, filter, sort])

  const tabs: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'open', label: 'Open' },
    { id: 'claim', label: 'To claim' },
  ]

  return (
    <section className="card pf-card" aria-labelledby="pf-positions-h">
      <div className="pf-card-head">
        <div>
          <h2 id="pf-positions-h">Your calls</h2>
          <p className="pf-card-sub">Odds right now, and what each one pays if you're right.</p>
        </div>
        {positions.length > 0 && (
          <div className="pf-controls">
            <div className="pf-seg-tabs" role="tablist" aria-label="Filter positions">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={filter === t.id}
                  className={filter === t.id ? 'on' : ''}
                  onClick={() => setFilter(t.id)}
                >
                  {t.label}
                  <span className={`pf-count${t.id === 'claim' && counts.claim > 0 ? ' hot' : ''}`}>{counts[t.id]}</span>
                </button>
              ))}
            </div>
            <label className="pf-sort">
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort positions">
                <option value="value">Sort: Value</option>
                <option value="pnl">Sort: P&amp;L</option>
                <option value="move">Sort: Odds moved</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {props.loadError && <p className="error pf-error">Couldn't load positions: {props.loadError}</p>}

      {!props.loaded ? (
        <div className="pf-loading" aria-label="Loading positions">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : positions.length === 0 ? (
        !props.loadError && (
          <div className="pf-empty-inline">
            <CandleArt size={64} />
            <h3>No calls yet.</h3>
            <p>Pick a side on any market. It shows up here with live odds and what it pays.</p>
            <a className="button" href="#/markets">
              Browse markets
            </a>
          </div>
        )
      ) : (
        <>
          <AllocationBar positions={positions} />
          {rows.length === 0 ? (
            <p className="pf-none">{filter === 'claim' ? 'Nothing to claim yet. Winners land here once a market resolves.' : 'No open calls right now.'}</p>
          ) : (
            <>
              <div className="pf-cols" aria-hidden="true">
                <span>Market</span>
                <span>Avg → now</span>
                <span>Value · P&amp;L</span>
                <span />
              </div>
              <ul className="pf-list">
                {rows.map((p) => (
                  <PositionRow key={p.asset} p={p} status={props.rowStatus[p.asset]} busy={props.busy} onSell={props.onSell} onClaim={props.onClaim} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
