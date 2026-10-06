import { useEffect, useMemo, useState } from 'react'
import { cumulative, fetchCallHistory, summarize, type ClosedCall } from '../lib/callHistory'
import { routeHref } from '../lib/router'

type Filter = 'all' | 'wins' | 'losses'

const PAGE = 25
const usd = (n: number) => Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (n: number) => `${n >= 0 ? '+' : '−'}$${usd(n)}`
const pct = (r: number | null) =>
  r === null ? '' : `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toLocaleString(undefined, { maximumFractionDigits: Math.abs(r) < 0.1 ? 1 : 0 })}%`
const shares = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const day = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(ts * 1000).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })

const RESULT_LABEL = { won: 'Called it', lost: 'Missed', sold: 'Cashed out' } as const

/** Running realized P&L as a tiny line with a zero baseline. */
function PnlSpark({ calls }: { calls: ClosedCall[] }) {
  const points = useMemo(() => cumulative(calls), [calls])
  if (points.length < 2) return null
  const w = 160
  const h = 44
  const values = points.map((p) => p.pnl)
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const span = Math.max(0.01, hi - lo)
  const x = (i: number) => (i / (points.length - 1)) * w
  const y = (v: number) => h - 3 - ((v - lo) / span) * (h - 6)
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(' ')
  const up = values[values.length - 1] >= 0
  return (
    <svg className={`pf-hist-spark ${up ? 'up' : 'down'}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={w} y1={y(0)} y2={y(0)} className="zero" />
      <path d={`${line} L${w},${y(0)} L0,${y(0)} Z`} className="area" />
      <path d={line} className="line" />
    </svg>
  )
}

function HistoryRow({ c }: { c: ClosedCall }) {
  const up = c.realizedPnl >= 0
  const title = c.eventSlug ? <a href={routeHref({ name: 'market', slug: c.eventSlug })}>{c.title}</a> : c.title
  return (
    <li className={`pf-hist-row ${c.result}`}>
      {c.icon ? <img className="pf-hist-icon" src={c.icon} alt="" loading="lazy" /> : <span className="pf-hist-icon" />}
      <div className="pf-hist-main">
        <div className="pf-hist-title">{title}</div>
        <div className="pf-hist-meta num">
          <span className={`badge ${/^(no|down)$/i.test(c.outcome) ? 'no' : 'yes'}`}>{c.outcome}</span>
          <span className={`pf-chip result ${c.result}`}>{RESULT_LABEL[c.result]}</span>
          <span>
            {shares(c.shares)} @ {(c.avgPrice * 100).toFixed(1)}¢
          </span>
          <span>staked ${usd(c.cost)}</span>
          <span>
            {day(c.openedAt)} → {day(c.closedAt)}
          </span>
        </div>
      </div>
      <div className={`pf-hist-pnl num ${up ? 'up' : 'down'}`}>
        <b>{money(c.realizedPnl)}</b>
        <span>{pct(c.ret)}</span>
      </div>
    </li>
  )
}

/** Closed calls with realized profit and loss: the scoreboard of past calls. */
export function CallHistory({ wallet, refreshKey }: { wallet: string; refreshKey: number }) {
  const [calls, setCalls] = useState<ClosedCall[] | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    let cancelled = false
    fetchCallHistory(wallet)
      .then((page) => {
        if (cancelled) return
        setCalls(page.calls)
        setNext(page.next)
        setError('')
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [wallet, refreshKey])

  async function loadOlder() {
    if (!next) return
    setLoadingMore(true)
    try {
      const page = await fetchCallHistory(wallet, next)
      setCalls((prev) => {
        const seen = new Set((prev ?? []).map((c) => c.asset))
        return [...(prev ?? []), ...page.calls.filter((c) => !seen.has(c.asset))]
      })
      setNext(page.next)
      setShown((n) => n + PAGE)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const summary = useMemo(() => summarize(calls ?? []), [calls])
  const rows = useMemo(
    () =>
      (calls ?? []).filter((c) =>
        filter === 'all' ? true : filter === 'wins' ? c.realizedPnl > 0.005 : c.realizedPnl < -0.005,
      ),
    [calls, filter],
  )
  const tabs: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: summary.count },
    { id: 'wins', label: 'Wins', count: summary.wins },
    { id: 'losses', label: 'Losses', count: summary.losses },
  ]

  return (
    <section className="card pf-card pf-hist" aria-labelledby="pf-hist-h">
      <div className="pf-card-head">
        <div>
          <h2 id="pf-hist-h">Call history</h2>
          <p className="pf-card-sub">Every call you sold or saw resolve, and what it made or lost.</p>
        </div>
        {summary.count > 0 && (
          <div className="pf-seg-tabs" role="tablist" aria-label="Filter call history">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={filter === t.id} className={filter === t.id ? 'on' : ''} onClick={() => setFilter(t.id)}>
                {t.label}
                <span className="pf-count">{t.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && !calls && <p className="error pf-error">Couldn't load your call history: {error}</p>}

      {!calls ? (
        !error && (
          <div className="pf-loading" aria-label="Loading call history">
            <div className="skeleton" />
          </div>
        )
      ) : calls.length === 0 ? (
        <p className="pf-none">No closed calls yet. When you sell a position or a market resolves, it lands here with its profit or loss.</p>
      ) : (
        <>
          <div className="pf-hist-stats">
            <div className={`pf-hist-stat main ${summary.realized >= 0 ? 'up' : 'down'}`}>
              <span className="eyebrow">Realized P&amp;L</span>
              <b className="num">{money(summary.realized)}</b>
              <small className="num">
                {summary.invested > 0 && <>{pct(summary.realized / summary.invested)} on ${usd(summary.invested)} staked</>}
              </small>
              <PnlSpark calls={calls} />
            </div>
            <div className="pf-hist-stat">
              <span className="eyebrow">Win rate</span>
              <b className="num">{summary.winRate === null ? '—' : `${Math.round(summary.winRate * 100)}%`}</b>
              <small className="num">
                {summary.wins} won · {summary.losses} lost
              </small>
              {summary.winRate !== null && (
                <span className="pf-hist-rate" aria-hidden="true">
                  <i style={{ width: `${summary.winRate * 100}%` }} />
                </span>
              )}
            </div>
            <div className="pf-hist-stat">
              <span className="eyebrow">Best call</span>
              {summary.best ? (
                <>
                  <b className="num up">{money(summary.best.realizedPnl)}</b>
                  <small title={summary.best.title}>{summary.best.title}</small>
                </>
              ) : (
                <b className="num">—</b>
              )}
            </div>
            <div className="pf-hist-stat">
              <span className="eyebrow">Toughest call</span>
              {summary.worst ? (
                <>
                  <b className="num down">{money(summary.worst.realizedPnl)}</b>
                  <small title={summary.worst.title}>{summary.worst.title}</small>
                </>
              ) : (
                <b className="num">—</b>
              )}
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="pf-none">{filter === 'wins' ? 'No winning calls in this list yet.' : 'No losing calls here. Nice.'}</p>
          ) : (
            <ul className="pf-hist-list">
              {rows.slice(0, shown).map((c) => (
                <HistoryRow key={`${c.asset}-${c.closedAt}`} c={c} />
              ))}
            </ul>
          )}
          {rows.length > shown ? (
            <button className="ghost pf-more" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more
            </button>
          ) : (
            next && (
              <button className="ghost pf-more" disabled={loadingMore} onClick={loadOlder}>
                {loadingMore ? 'Loading…' : 'Load older calls'}
              </button>
            )
          )}
          <p className="pf-hist-note">
            Realized P&amp;L after fees, from Polymarket's records{next ? `, for your ${calls.length} most recent closed calls` : ''}. Past
            results don't predict future ones.
          </p>
        </>
      )}
    </section>
  )
}
