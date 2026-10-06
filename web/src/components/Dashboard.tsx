import { useEffect, useState, type ReactNode } from 'react'
import type { ActivityItem } from '../lib/activity'
import {
  callingCard,
  compactUsd,
  drawable,
  fetchPnlSeries,
  PNL_RANGES,
  periodChange,
  withBaseline,
  type PnlPoint,
  type PnlRange,
} from '../lib/dashboard'
import { LiveAmount } from './LiveAmount'
import { PnlChart, whenLabel } from './PnlChart'

const money = (n: number) =>
  `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * A wallet's "candle signature": five candles derived from its address, in the brand's mint and coral.
 * The same address always draws the same mark.
 */
export function CandleSignature({ address, size = 48 }: { address: string; size?: number }) {
  const hex = address.toLowerCase().replace(/^0x/, '').padEnd(40, '0')
  const candles = Array.from({ length: 5 }, (_, i) => {
    const a = parseInt(hex[i * 4], 16)
    const b = parseInt(hex[i * 4 + 1], 16)
    const c = parseInt(hex[i * 4 + 2], 16)
    const up = parseInt(hex[i * 4 + 3], 16) % 2 === 0
    const bodyH = 6 + (a % 10) * 1.6
    const mid = 14 + (b % 12) * 1.3
    const wick = 3 + (c % 5)
    return { up, top: mid - bodyH / 2, bodyH, wick }
  })
  return (
    <svg className="sig" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <rect className="sig-tile" x="0.5" y="0.5" width="47" height="47" rx="14" />
      {candles.map((k, i) => {
        const x = 9 + i * 7.5
        return (
          <g key={i} className={k.up ? 'sig-up' : 'sig-down'}>
            <line x1={x} x2={x} y1={k.top - k.wick} y2={k.top + k.bodyH + k.wick} />
            <rect x={x - 2.4} y={k.top} width={4.8} height={k.bodyH} rx={1.4} />
          </g>
        )
      })}
    </svg>
  )
}

/** Total value with the cash / in-calls split. `cash` is null when it isn't known (someone else's profile). */
export function ValueCard(props: {
  cash: string | null
  showCash: boolean
  positionsValue: number
  unrealized: number
  positions: number
  actions?: boolean
  /** Extra content under the figure (the profile page's facts and call to action). */
  children?: ReactNode
}) {
  const cash = props.showCash ? (props.cash === null ? null : Number(props.cash)) : 0
  const total = cash === null ? null : cash + props.positionsValue
  const up = props.unrealized >= 0
  const cashShare = total && total > 0 && cash !== null ? cash / total : 0
  const [whole, cents] = (total ?? 0).toFixed(2).split('.')

  return (
    <section className="card dash-value" aria-label="Portfolio value">
      <div className="dash-value-top">
        <span className="eyebrow">{props.showCash ? 'Portfolio value' : 'Positions value'}</span>
        <div className="pf-total num">
          {total === null ? (
            <span className="pf-total-wait">$…</span>
          ) : (
            <>
              <span className="pf-cur">$</span>
              {Number(whole).toLocaleString()}
              <span className="pf-cents">.{cents}</span>
            </>
          )}
        </div>
        {props.positions > 0 && (
          <div className="pf-pnl-line">
            <span className={`pf-pnl ${up ? 'up' : 'down'}`}>
              {up ? '▲ ' : '▼ '}
              {money(props.unrealized)}
            </span>
            <span className="muted">open, at current prices</span>
          </div>
        )}
      </div>

      {props.showCash && (
        <div className="dash-split">
          <div
            className="pf-split-bar"
            role="img"
            aria-label={`${Math.round(cashShare * 100)}% cash, ${Math.round((1 - cashShare) * 100)}% in calls`}
          >
            {total !== null && total > 0 ? (
              <>
                <span className="cash" style={{ flexGrow: cash ?? 0 }} />
                <span className={`calls ${up ? 'up' : 'down'}`} style={{ flexGrow: props.positionsValue }} />
              </>
            ) : (
              <span className="none" />
            )}
          </div>
          <div className="pf-split-legend">
            <div>
              <span className="pf-split-k">
                <i className="pf-key cash" /> Cash
              </span>
              <b className="num">
                $<LiveAmount value={props.cash} />
              </b>
            </div>
            <div>
              <span className="pf-split-k">
                <i className={`pf-key ${up ? 'up' : 'down'}`} /> In calls
              </span>
              <b className="num">${props.positionsValue.toFixed(2)}</b>
            </div>
          </div>
        </div>
      )}

      {props.children}

      {props.actions && (
        <div className="dash-actions">
          <a className="button" href="#/wallet">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.5v7M4.8 6.5 8 9.7l3.2-3.2M3 13h10" />
            </svg>
            Deposit
          </a>
          <a className="button ghost" href="#/wallet?d=withdraw">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 10V3M4.8 6 8 2.8 11.2 6M3 13h10" />
            </svg>
            Withdraw
          </a>
        </div>
      )}
    </section>
  )
}

const RANGE_WORDS: Record<PnlRange, string> = { '1D': 'Past day', '1W': 'Past week', '1M': 'Past month', ALL: 'All time' }

/** Profit and loss with a range picker; scrubbing the chart rewrites the headline. */
export function PnlCard({ wallet, refreshKey }: { wallet: string; refreshKey: number }) {
  // ALL first: its figure is the headline P&L polymarket.com shows on a profile.
  const [range, setRange] = useState<PnlRange>('ALL')
  const [series, setSeries] = useState<Record<string, PnlPoint[]>>({})
  const [error, setError] = useState('')
  const [scrub, setScrub] = useState<PnlPoint | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Cached per wallet, refresh and range, so switching ranges back and forth doesn't refetch.
  const key = `${wallet}:${refreshKey}:${range}`
  const have = key in series

  useEffect(() => {
    if (have) return
    let cancelled = false
    fetchPnlSeries(wallet, range)
      .then((pts) => {
        if (cancelled) return
        setSeries((s) => ({ ...s, [key]: pts }))
        setError('')
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [key, have, wallet, range, attempt])

  const fetched = series[key] as PnlPoint[] | undefined
  const raw = fetched ? withBaseline(fetched, range) : undefined
  const points = raw ? drawable(raw) : null
  const change = raw ? periodChange(raw, range) : null
  const shown = scrub && points ? (range === 'ALL' ? scrub.p : scrub.p - points[0].p) : change
  const up = (shown ?? 0) >= 0
  const thin = raw !== undefined && raw.length < 2

  return (
    <section className="card dash-pnl" aria-label="Profit and loss">
      <div className="dash-pnl-head">
        <div className="dash-pnl-read">
          <span className="eyebrow">
            <i className={`dash-tick ${up ? 'up' : 'down'}`} aria-hidden="true" />
            Profit / Loss
          </span>
          <div className={`dash-pnl-big num ${shown === null ? '' : up ? 'up' : 'down'}`} aria-live="polite">
            {shown === null ? <span className="pf-total-wait">$…</span> : money(shown)}
          </div>
          <span className="dash-pnl-when">{scrub ? whenLabel(scrub.t, range) : RANGE_WORDS[range]}</span>
        </div>
        <div className="pf-seg-tabs" role="group" aria-label="Time range">
          {PNL_RANGES.map((r) => (
            <button key={r} type="button" className={r === range ? 'on' : undefined} aria-pressed={r === range} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>
      {error && !points ? (
        <p className="pf-warn dash-retry">
          P&amp;L history is unavailable right now.
          <button
            type="button"
            className="link"
            onClick={() => {
              setError('')
              setAttempt((n) => n + 1)
            }}
          >
            Retry
          </button>
        </p>
      ) : points ? (
        <>
          <PnlChart points={points} range={range} onScrub={setScrub} />
          {thin && <p className="dash-thin">Your chart grows as you trade. Each call adds to the line.</p>}
        </>
      ) : (
        <div className="skeleton dash-pnl-skel" />
      )}
    </section>
  )
}

/** Volume, markets, Yay/Nay lean and caller style, from the loaded trades. */
export function CallingCardStrip(props: { items: ActivityItem[] | null; partial: boolean; marketsTraded: number | null }) {
  const card = callingCard(props.items ?? [])
  const loading = props.items === null
  const empty = !loading && card.trades === 0
  const pct = (x: number) => Math.round(x * 100)
  const lead =
    card.lean.yay >= 0.55 ? 'Mostly Yay' : card.lean.nay >= 0.55 ? 'Mostly Nay' : card.lean.pick >= 0.55 ? 'Mostly picks' : 'Mixed calls'
  const from = props.partial ? `last ${card.trades} trades` : `${card.trades} ${card.trades === 1 ? 'trade' : 'trades'}`

  return (
    <section className={`dash-card${empty ? ' empty' : ''}`} aria-label="Calling card">
      <div className="dash-tile">
        <span className="eyebrow">Volume</span>
        <b className="num">{loading ? '…' : compactUsd(card.volume)}</b>
        <small>{empty ? 'Bought plus sold' : `across ${from}`}</small>
      </div>

      <div className="dash-tile">
        <span className="eyebrow">Markets traded</span>
        <b className="num">{props.marketsTraded ?? '…'}</b>
        <small>
          {card.streak > 1 ? (
            <span className="dash-streak">
              <i aria-hidden="true" /> {card.streak}-day streak
            </span>
          ) : (
            'Distinct markets'
          )}
        </small>
      </div>

      <div className="dash-tile lean">
        <span className="eyebrow">Yay or Nay?</span>
        <b>{loading ? '…' : empty ? '—' : lead}</b>
        <div className="dash-lean" role="img" aria-label={`${pct(card.lean.yay)}% Yay, ${pct(card.lean.nay)}% Nay, ${pct(card.lean.pick)}% picks`}>
          {empty || loading ? (
            <span className="none" />
          ) : (
            <>
              {(['yay', 'nay', 'pick'] as const)
                .filter((k) => card.lean[k] > 0)
                .map((k) => (
                  <span key={k} className={`l-${k}`} style={{ flexGrow: card.lean[k] }} />
                ))}
            </>
          )}
        </div>
        <small className="dash-lean-legend num">
          <span className="l-yay">{pct(card.lean.yay)}% Yay</span>
          <span className="l-nay">{pct(card.lean.nay)}% Nay</span>
          {card.lean.pick > 0 && <span className="l-pick">{pct(card.lean.pick)}% picks</span>}
        </small>
      </div>

      <div className={`dash-tile style${card.style ? ` s-${card.style.id}` : ''}`}>
        <span className="eyebrow">Caller style</span>
        <b>{loading ? '…' : (card.style?.label ?? 'Not yet known')}</b>
        <div className="dash-dial" aria-hidden="true">
          <span className="dash-dial-track" />
          {card.avgEntry !== null && <span className="dash-dial-pin" style={{ left: `${card.avgEntry * 100}%` }} />}
          <span className="dash-dial-ends">
            <i>1¢</i>
            <i>50¢</i>
            <i>99¢</i>
          </span>
        </div>
        <small>
          {card.avgEntry === null
            ? 'Make a call to find out'
            : `Avg entry ${(card.avgEntry * 100).toFixed(0)}¢ · ${card.style?.blurb ?? ''}`}
        </small>
      </div>
    </section>
  )
}
