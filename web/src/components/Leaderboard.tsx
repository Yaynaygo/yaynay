import { useCallback, useEffect, useState } from 'react'
import {
  barShare,
  fetchLeaders,
  fetchMyRank,
  LEADER_CATEGORIES,
  LEADER_PERIODS,
  rankLabel,
  type Leader,
  type LeaderPeriod,
  type LeaderSort,
  type MyRank,
} from '../lib/leaderboard'
import { routeHref } from '../lib/router'
import { CandleSignature } from './Dashboard'
import '../styles/portfolio.css'
import '../styles/dashboard.css'
import '../styles/leaderboard.css'

/** $940, $2.7k, $14.1M: whole figures, so a column of mixed sizes stays readable. */
const compactUsd = (n: number) => {
  const a = Math.abs(n)
  const s = n < 0 ? '−' : ''
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`
  return `${s}$${a.toFixed(a >= 100 ? 0 : 2)}`
}
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${compactUsd(Math.abs(n))}`

function Badges({ l }: { l: Leader }) {
  return (
    <>
      {l.verified && (
        <span className="lb-verified" title="Verified on Polymarket" aria-label="Verified">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 8.3 6.8 11 12 5.5" />
          </svg>
        </span>
      )}
      {l.x && (
        <a
          className="lb-x"
          href={`https://x.com/${encodeURIComponent(l.x)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={`@${l.x} on X`}
        >
          @{l.x}
        </a>
      )}
    </>
  )
}

/** Top three as candles on a podium: the taller the candle, the higher the rank. */
function Podium({ rows, sort }: { rows: Leader[]; sort: LeaderSort }) {
  const order = [rows[1], rows[0], rows[2]].filter(Boolean)
  // Candle heights in px: the winner stands tallest.
  const height: Record<number, number> = { 1: 170, 2: 126, 3: 96 }
  return (
    <div className="lb-podium" role="list" aria-label="Top three">
      {order.map((l) => {
        const up = l.pnl >= 0
        const main = sort === 'PNL' ? signed(l.pnl) : compactUsd(l.volume)
        return (
          <a key={l.wallet} role="listitem" className={`lb-step r${l.rank}`} href={routeHref({ name: 'profile', wallet: l.wallet })}>
            <div className="lb-step-who">
              {l.rank === 1 && <span className="lb-crown">Top caller</span>}
              <CandleSignature address={l.wallet} size={l.rank === 1 ? 56 : 46} />
              <span className="lb-step-name">{l.name}</span>
              <span className={`lb-step-val num ${sort === 'PNL' ? (up ? 'up' : 'down') : ''}`}>{main}</span>
              <span className="lb-step-sub num">{sort === 'PNL' ? `${compactUsd(l.volume)} vol` : `${signed(l.pnl)} P&L`}</span>
            </div>
            <div className={`lb-candle ${up ? 'up' : 'down'}`} style={{ height: height[l.rank] ?? 90 }}>
              <span className="lb-wick" aria-hidden="true" />
              <span className="lb-body">
                <b>{l.rank}</b>
              </span>
            </div>
          </a>
        )
      })}
    </div>
  )
}

/** Polymarket's trader leaderboard with periods, categories, P&L or volume ranking, and your own rank. */
export function Leaderboard({ polyWallet }: { polyWallet: string | null }) {
  const [period, setPeriod] = useState<LeaderPeriod>('week')
  const [sort, setSort] = useState<LeaderSort>('PNL')
  const [category, setCategory] = useState('overall')
  const [rows, setRows] = useState<Leader[] | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [me, setMe] = useState<MyRank | null>(null)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    fetchLeaders({ period, sort, category })
      .then((p) => {
        if (cancelled) return
        setRows(p.rows)
        setNext(p.next)
        setError('')
      })
      .catch((e) => {
        if (cancelled) return
        setRows([])
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [period, sort, category])

  useEffect(() => {
    if (!polyWallet) return
    let cancelled = false
    fetchMyRank(polyWallet, period).then((r) => !cancelled && setMe(r))
    return () => {
      cancelled = true
    }
  }, [polyWallet, period])

  const loadMore = useCallback(() => {
    if (!next || loadingMore) return
    setLoadingMore(true)
    fetchLeaders({ period, sort, category }, next)
      .then((p) => {
        setRows((r) => [...(r ?? []), ...p.rows.filter((x) => !(r ?? []).some((y) => y.wallet === x.wallet))])
        setNext(p.next)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMore(false))
  }, [next, loadingMore, period, sort, category])

  const top = rows?.[0]
  const podium = rows && rows.length >= 3 ? rows.slice(0, 3) : []
  const list = rows ? rows.slice(podium.length) : []
  const periodWord = LEADER_PERIODS.find((p) => p.id === period)?.label.toLowerCase()

  return (
    <div className="lb-page">
      <div className="section-head">
        <div>
          <span className="eyebrow accent">Polymarket traders</span>
          <h1>Leaderboard</h1>
          <p className="section-sub">The sharpest callers on Polymarket. Tap anyone to see their calling card.</p>
        </div>
      </div>

      {polyWallet && me && (
        <a className="card lb-me" href={routeHref({ name: 'profile', wallet: polyWallet })}>
          <CandleSignature address={polyWallet} size={44} />
          <div className="lb-me-text">
            <span className="eyebrow">Your standing · {periodWord}</span>
            <b className="num">{me.rankPnl ? `${rankLabel(me.rankPnl)} by profit` : 'Not ranked yet'}</b>
          </div>
          <div className="lb-me-figs num">
            <span className={me.pnl >= 0 ? 'up' : 'down'}>{signed(me.pnl)}</span>
            <small>{compactUsd(me.volume)} volume</small>
          </div>
          <span className="lb-me-go" aria-hidden="true">
            →
          </span>
        </a>
      )}

      <div className="card lb-board">
        <div className="lb-controls">
          <div className="pf-seg-tabs" role="group" aria-label="Period">
            {LEADER_PERIODS.map((p) => (
              <button key={p.id} type="button" className={p.id === period ? 'on' : undefined} aria-pressed={p.id === period} onClick={() => setPeriod(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="pf-seg-tabs lb-sort" role="group" aria-label="Rank by">
            {(['PNL', 'VOLUME'] as const).map((s) => (
              <button key={s} type="button" className={s === sort ? 'on' : undefined} aria-pressed={s === sort} onClick={() => setSort(s)}>
                {s === 'PNL' ? 'Profit' : 'Volume'}
              </button>
            ))}
          </div>
        </div>
        <div className="act-filters lb-cats" role="group" aria-label="Category">
          {LEADER_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`act-filter${c.id === category ? ' on' : ''}`}
              aria-pressed={c.id === category}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {error && rows?.length === 0 ? (
          <p className="pf-warn">The leaderboard is unavailable right now. Try again in a minute.</p>
        ) : rows === null ? (
          <div className="lb-skel" aria-label="Loading leaderboard">
            <div className="skeleton lb-skel-podium" />
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : rows.length === 0 ? (
          <p className="pf-none">Nobody ranked here yet.</p>
        ) : (
          <>
            {podium.length === 3 && <Podium rows={podium} sort={sort} />}
            <div className="lb-cols" aria-hidden="true">
              <span>Rank</span>
              <span>Trader</span>
              <span>{sort === 'PNL' ? 'Profit' : 'Volume'}</span>
              <span>{sort === 'PNL' ? 'Volume' : 'Profit'}</span>
            </div>
            <ol className="lb-list" start={list[0]?.rank}>
              {list.map((l) => {
                const up = l.pnl >= 0
                const mine = polyWallet?.toLowerCase() === l.wallet
                return (
                  <li key={l.wallet} className={mine ? 'mine' : undefined}>
                    {/* The name link stretches over the whole row, so the X link inside stays a separate link. */}
                    <div className="lb-row">
                      <span className="lb-rank num">{l.rank}</span>
                      <span className="lb-who">
                        <CandleSignature address={l.wallet} size={34} />
                        <span className="lb-name">
                          <a className="lb-row-link" href={routeHref({ name: 'profile', wallet: l.wallet })}>
                            {l.name}
                          </a>
                          {mine && <span className="lb-you">You</span>}
                          <Badges l={l} />
                        </span>
                      </span>
                      <span className="lb-main num">
                        <span className={sort === 'PNL' ? (up ? 'up' : 'down') : undefined}>
                          {sort === 'PNL' ? signed(l.pnl) : compactUsd(l.volume)}
                        </span>
                        <i className={`lb-bar ${sort === 'PNL' ? (up ? 'up' : 'down') : 'vol'}`}>
                          <i style={{ width: `${Math.max(2, barShare(l, top, sort) * 100)}%` }} />
                        </i>
                      </span>
                      <span className={`lb-alt num ${sort === 'VOLUME' ? (up ? 'up' : 'down') : ''}`}>
                        {sort === 'PNL' ? compactUsd(l.volume) : signed(l.pnl)}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ol>
            {next && (
              <button className="subtle pf-more" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show next 50'}
              </button>
            )}
            <p className="lb-note">Ranks and figures come from Polymarket and include all trading, not only trades made on YayNay.</p>
          </>
        )}
      </div>
    </div>
  )
}
