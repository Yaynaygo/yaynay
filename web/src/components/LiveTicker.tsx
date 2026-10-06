import { useEffect, useState } from 'react'
import { diversify, fetchRecentTrades, type TapeTrade } from '../lib/history'
import { routeHref } from '../lib/router'
import { Logo } from './Logo'

const SECONDS_PER_CALL = 6
/** Calls at or above this size get the highlight ring. */
const BIG_CALL_USD = 1_000

const usd = (n: number) => (n >= 10_000 ? `$${(n / 1000).toFixed(0)}k` : n >= 1_000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`)

function ago(ts: number) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`
}

/** Yay / Nay for yes-no markets; otherwise the outcome's own name (a team, "Up", a price band). */
function side(t: TapeTrade): { label: string; yay: boolean } {
  const yay = t.outcomeIndex === 0
  if (/^(yes|no)$/i.test(t.outcome)) return { label: yay ? 'Yay' : 'Nay', yay }
  const name = t.outcome.length > 16 ? `${t.outcome.slice(0, 15)}…` : t.outcome
  return { label: name, yay }
}

/** A tiny candle: rising for a call on the first outcome, falling for the second. */
function MiniCandle({ up }: { up: boolean }) {
  return (
    <svg className={`calls-candle ${up ? 'up' : 'down'}`} width="8" height="14" viewBox="0 0 8 14" aria-hidden="true">
      <path d="M4 0.5v13" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="1" y={up ? 2.5 : 5} width="6" height={up ? 8 : 6} rx="1.6" />
    </svg>
  )
}

function CallChip({ t, hidden }: { t: TapeTrade; hidden: boolean }) {
  const s = side(t)
  const sold = t.side === 'SELL'
  const big = t.usd >= BIG_CALL_USD
  const title = t.title.length > 42 ? `${t.title.slice(0, 41)}…` : t.title
  const body = (
    <>
      <MiniCandle up={sold ? !s.yay : s.yay} />
      <span className={`calls-side ${s.yay ? 'yay' : 'nay'}${sold ? ' sold' : ''}`}>{sold ? `Sold ${s.label}` : s.label}</span>
      <b className="calls-usd">{usd(t.usd)}</b>
      {t.icon ? <img className="calls-icon" src={t.icon} alt="" loading="lazy" /> : null}
      <span className="calls-title">{title}</span>
      <span className="calls-meta">
        {Math.round(t.price * 100)}¢ · {ago(t.timestamp)}
      </span>
    </>
  )
  const cls = `calls-chip${big ? ' big' : ''}`
  return t.eventSlug ? (
    <a className={cls} href={routeHref({ name: 'market', slug: t.eventSlug })} tabIndex={hidden ? -1 : undefined} aria-hidden={hidden || undefined}>
      {body}
    </a>
  ) : (
    <span className={cls} aria-hidden={hidden || undefined}>
      {body}
    </span>
  )
}

/** YayNay's live tape: what the crowd is calling right now on Polymarket, each call one tap from its market. */
export function LiveTicker() {
  const [trades, setTrades] = useState<TapeTrade[]>([])
  // Money called (bought) in the last five minutes, measured when the feed loads.
  const [recent, setRecent] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetchRecentTrades(200)
        .then((t) => {
          const calls = diversify(t).slice(0, 22)
          if (cancelled || calls.length === 0) return
          setTrades(calls)
          const since = Date.now() / 1000 - 5 * 60
          setRecent(t.filter((x) => x.timestamp >= since && x.side === 'BUY').reduce((sum, x) => sum + x.usd, 0))
        })
        .catch(() => {})
    load()
    const id = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (trades.length === 0) return null
  // Rendered twice so the loop is seamless; the copy is hidden from assistive tech.
  const items = [...trades, ...trades]
  return (
    <div className="calls" aria-label="Live calls on Polymarket">
      <div className="calls-label">
        <Logo size={18} />
        <span className="calls-label-text">
          <b>Calls now</b>
          {recent >= 1 && <span className="num">{usd(recent)} · 5 min</span>}
        </span>
      </div>
      <div className="calls-window">
        <div className="calls-track" style={{ animationDuration: `${trades.length * SECONDS_PER_CALL}s` }}>
          {items.map((t, i) => (
            <CallChip key={i} t={t} hidden={i >= trades.length} />
          ))}
        </div>
      </div>
    </div>
  )
}
