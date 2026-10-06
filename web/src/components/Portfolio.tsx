import { useState } from 'react'
import type { PolyClient } from '../lib/polyAccount'
import { Activity } from './Activity'
import { CallHistory } from './CallHistory'
import { LiveAmount } from './LiveAmount'
import { CandleArt, Positions } from './Positions'
import '../styles/portfolio.css'
import type { BalanceDelta } from '../lib/balanceHint'

type Totals = { value: number; pnl: number; count: number }

/** The portfolio page: balances, open calls and activity. */
export function Portfolio(props: {
  isConnected: boolean
  client: PolyClient | null
  /** 1-click trading session client; orders signed without wallet prompts when set. */
  tradeClient: PolyClient | null
  polyWallet: `0x${string}` | null
  /** The user's Arc address. */
  address?: string
  pusd: string | null
  refreshKey: number
  onConnect: () => void
  onLink: () => void
  onPolygon: () => Promise<void>
  onChanged: (delta?: BalanceDelta) => void
}) {
  const [totals, setTotals] = useState<Totals>({ value: 0, pnl: 0, count: 0 })
  const { client, polyWallet } = props

  return (
    <div className="pf-page">
      <div className="section-head">
        <div>
          <h1>Portfolio</h1>
          <p className="section-sub">Your calls, their odds right now, and what they pay if you're right.</p>
        </div>
      </div>
      {!client || !polyWallet ? (
        <PortfolioGate connected={props.isConnected} onConnect={props.onConnect} onLink={props.onLink} />
      ) : (
        <>
          <PortfolioSummary pusd={props.pusd} totals={totals} />
          <Positions
            client={client}
            tradeClient={props.tradeClient}
            wallet={polyWallet}
            refreshKey={props.refreshKey}
            onPolygon={props.onPolygon}
            onChanged={props.onChanged}
            pusdBalance={props.pusd}
            onTotals={setTotals}
          />
          <CallHistory wallet={polyWallet} refreshKey={props.refreshKey} />
          {props.address && <Activity wallet={polyWallet} arcAddress={props.address} refreshKey={props.refreshKey} />}
        </>
      )}
    </div>
  )
}

/** Shown before a wallet is connected or a Polymarket account is linked. */
export function PortfolioGate(props: { connected: boolean; onConnect: () => void; onLink: () => void }) {
  return (
    <div className="card pf-gate">
      <CandleArt size={84} />
      <div className="pf-gate-text">
        <span className="eyebrow">{props.connected ? 'One step left' : 'Nothing to show yet'}</span>
        <h2>{props.connected ? 'Link Polymarket to see your calls.' : 'Your calls live here.'}</h2>
        <p>
          {props.connected
            ? 'Link your Polymarket account once and this page fills with your positions, live P&L and history.'
            : 'Connect a wallet to see what you hold, how the odds moved, and what each call pays if you are right.'}
        </p>
      </div>
      <div className="pf-gate-actions">
        {props.connected ? (
          <button onClick={props.onLink}>Link account</button>
        ) : (
          <button onClick={props.onConnect}>Connect wallet</button>
        )}
        <a className="button ghost" href="#/markets">
          Browse markets
        </a>
      </div>
      <ul className="pf-gate-points">
        <li>
          <b>Live P&amp;L</b> on every call
        </li>
        <li>
          <b>Cash out</b> any time there is a buyer
        </li>
        <li>
          <b>Claim</b> winnings in one tap
        </li>
      </ul>
    </div>
  )
}

/** Total value, unrealized P&L, cash vs invested, and the two next moves. */
export function PortfolioSummary({ pusd, totals }: { pusd: string | null; totals: Totals }) {
  const cash = pusd === null ? null : Number(pusd)
  const total = cash === null ? null : cash + totals.value
  const cost = totals.value - totals.pnl
  const pnlPct = cost > 0.005 ? totals.pnl / cost : null
  const up = totals.pnl >= 0
  const cashShare = total && total > 0 && cash !== null ? cash / total : 0
  const [whole, cents] = (total ?? 0).toFixed(2).split('.')

  return (
    <section className="card pf-hero" aria-label="Portfolio summary">
      <div className="pf-hero-main">
        <span className="eyebrow">Total value</span>
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
        <div className="pf-pnl-line">
          <span className={`pf-pnl ${totals.count === 0 ? 'flat' : up ? 'up' : 'down'}`}>
            {totals.count === 0 ? '' : up ? '▲ ' : '▼ '}
            {up ? '+' : '−'}${Math.abs(totals.pnl).toFixed(2)}
            {pnlPct !== null && <span> ({up ? '+' : '−'}{Math.abs(pnlPct * 100).toFixed(1)}%)</span>}
          </span>
          <span className="muted">unrealized, at current prices</span>
        </div>
      </div>

      <div className="pf-split">
        <div className="pf-split-bar" role="img" aria-label={`${Math.round(cashShare * 100)}% cash, ${Math.round((1 - cashShare) * 100)}% in calls`}>
          {total !== null && total > 0 ? (
            <>
              <span className="cash" style={{ flexGrow: cash ?? 0 }} />
              <span className={`calls ${up ? 'up' : 'down'}`} style={{ flexGrow: totals.value }} />
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
              $<LiveAmount value={pusd} />
            </b>
            <small>pUSD ready to trade</small>
          </div>
          <div>
            <span className="pf-split-k">
              <i className={`pf-key ${up ? 'up' : 'down'}`} /> In calls
            </span>
            <b className="num">${totals.value.toFixed(2)}</b>
            <small>
              {totals.count} {totals.count === 1 ? 'position' : 'positions'}
            </small>
          </div>
        </div>
      </div>

      <div className="pf-hero-actions">
        <a className="button" href="#/wallet">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2.5v7M4.8 6.5 8 9.7l3.2-3.2M3 13h10" />
          </svg>
          Deposit from Arc
        </a>
        <a className="button ghost" href="#/markets">
          Make a call
          <span aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  )
}
