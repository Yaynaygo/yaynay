import { useEffect, useId, useState } from 'react'
import {
  bestRank,
  fetchNansenStats,
  HOLDERS_LIMIT,
  leanHeadline,
  loadSmartMoney,
  nansenEnabled,
  TOP_N,
  type NansenStats,
  type SmartHolder,
  type SmartSummary,
} from '../lib/smartMoney'
import '../styles/smartmoney.css'

const SHOWN = 6
/** Nansen lookups cost credits; only enrich the rows on screen. */
const NANSEN_ROWS = SHOWN

const money = (n: number) => {
  const a = Math.abs(n)
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `$${a.toFixed(0)}`
  return n < 0 ? `−${s}` : s
}
const shares = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0))
const sideClass = (i: number) => (i === 0 ? 'yes' : 'no')

function Info() {
  const [open, setOpen] = useState(false)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open])
  return (
    <span className="sm-info">
      <button
        type="button"
        className="sm-info-btn"
        aria-label="How smart money is measured"
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      <span role="tooltip" id={id} className={`sm-tip${open ? ' open' : ''}`}>
        We take the top {TOP_N} Polymarket traders by profit, all-time and this month, and look for them among the{' '}
        {HOLDERS_LIMIT} largest holders of each side. Each trader counts once, on the side they are net long; the lean
        weighs positions by their value at the current price. Rankings reflect past results only. This is not advice
        and not a prediction.
      </span>
    </span>
  )
}

function Row({ h, outcome, stats }: { h: SmartHolder; outcome: string; stats?: NansenStats | null }) {
  const best = bestRank(h.trader)
  return (
    <li className="sm-row">
      <span className={`sm-rank ${best.period}`} title={best.period === 'all' ? 'All-time PnL rank' : 'This month’s PnL rank'}>
        #{best.rank}
        <small>{best.period === 'all' ? 'all-time' : 'month'}</small>
      </span>
      <span className="sm-who">
        <b title={h.name}>{h.name}</b>
        <small className="num">
          <span className={best.pnl >= 0 ? 'up' : 'down'}>
            {best.pnl >= 0 ? '+' : ''}
            {money(best.pnl)}
          </span>{' '}
          PnL {best.period === 'all' ? 'all-time' : 'this month'}
          {stats?.winRate != null && <> · {Math.round(stats.winRate * 100)}% win</>}
          {stats?.realizedPnl != null && <> · {money(stats.realizedPnl)} realised</>}
        </small>
      </span>
      <span className="sm-pos">
        <span className={`sm-chip ${sideClass(h.outcomeIndex)}`}>{outcome}</span>
        <small className="num" title={h.hedged ? 'Also holds the other side; value shown is net' : undefined}>
          {shares(h.shares)} sh · {money(h.value)}
          {h.hedged ? ' net' : ''}
        </small>
      </span>
    </li>
  )
}

function Skeleton() {
  return (
    <div className="sm-skel" aria-hidden="true">
      <span className="sm-skel-line w60" />
      <span className="sm-skel-bar" />
      {[0, 1, 2].map((i) => (
        <span className="sm-skel-line" key={i} />
      ))}
    </div>
  )
}

export function SmartMoney(props: { conditionId: string; outcomes: { name: string; tokenId: string }[] }) {
  const { conditionId, outcomes } = props
  const tokens = outcomes.map((o) => `${o.name}:${o.tokenId}`).join('|')
  const [data, setData] = useState<SmartSummary | null>(null)
  const [error, setError] = useState('')
  const [all, setAll] = useState(false)
  const [stats, setStats] = useState<Record<string, NansenStats | null>>({})

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError('')
    setAll(false)
    setStats({})
    loadSmartMoney(conditionId, outcomes)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
    // outcomes is re-created by callers on every render; `tokens` is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditionId, tokens])

  useEffect(() => {
    if (!data || !nansenEnabled()) return
    let cancelled = false
    for (const h of data.holders.slice(0, NANSEN_ROWS)) {
      fetchNansenStats(h.wallet).then((s) => !cancelled && setStats((prev) => ({ ...prev, [h.wallet]: s })))
    }
    return () => {
      cancelled = true
    }
  }, [data])

  const name = (i: number) => outcomes[i]?.name ?? `Outcome ${i + 1}`
  const [a, b] = data?.sides ?? []
  const pctA = data && data.totalValue > 0 && a ? a.value / data.totalValue : 0.5
  const shown = data ? (all ? data.holders : data.holders.slice(0, SHOWN)) : []

  return (
    <section className="card sm" aria-busy={!data && !error}>
      <div className="sm-head">
        <div className="eyebrow accent">Smart money</div>
        <Info />
      </div>

      {error && !data && <p className="muted">Smart money data is unavailable right now. {error}</p>}
      {!data && !error && <Skeleton />}

      {data && data.holders.length === 0 && (
        <div className="sm-empty">
          <h2>No top-{TOP_N} traders hold this market yet</h2>
          <p className="muted">
            None of Polymarket’s {TOP_N} most profitable traders (all-time or this month) is among its largest holders.
          </p>
        </div>
      )}

      {data && data.holders.length > 0 && a && b && (
        <>
          <h2 className="sm-headline">{leanHeadline(data)}</h2>
          <p className="sm-sub">
            Where Polymarket’s top-{TOP_N} traders by profit hold this market, weighted by position value.
          </p>
          <div
            className="sm-bar"
            role="img"
            aria-label={`${a.name} ${Math.round(pctA * 100)}% of smart money value, ${b.name} ${Math.round((1 - pctA) * 100)}%`}
          >
            <span className="sm-bar-yes" style={{ width: `${Math.max(2, Math.min(98, pctA * 100))}%` }} />
            <span className="sm-bar-no" />
          </div>
          <div className="sm-sides">
            {[a, b].map((s) => (
              <div className={`sm-side ${sideClass(s.outcomeIndex)}`} key={s.outcomeIndex}>
                <b>{s.name}</b>
                <span className="num">
                  {s.traders} trader{s.traders === 1 ? '' : 's'} · {money(s.value)}
                </span>
                <small className="num">{shares(s.shares)} shares</small>
              </div>
            ))}
          </div>

          <ol className="sm-list">
            {shown.map((h) => (
              <Row key={h.wallet} h={h} outcome={name(h.outcomeIndex)} stats={stats[h.wallet]} />
            ))}
          </ol>
          {data.holders.length > SHOWN && (
            <button type="button" className="link sm-more" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${data.holders.length}`}
            </button>
          )}
        </>
      )}

      <p className="sm-foot">Based on past profits. Not advice: top traders lose too.</p>
    </section>
  )
}
