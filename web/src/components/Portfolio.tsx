import { useEffect, useState } from 'react'
import { BRAND, shortAddress } from '../config'
import type { PolyClient } from '../lib/polyAccount'
import type { BalanceDelta } from '../lib/balanceHint'
import { fetchMarketsTraded, fetchPositionsValue, timeAgo } from '../lib/dashboard'
import { routeHref } from '../lib/router'
import { toast } from '../lib/toast'
import { ActivityPanel, useActivityFeed } from './Activity'
import { CallHistory } from './CallHistory'
import { CallingCardStrip, CandleSignature, PnlCard, ValueCard } from './Dashboard'
import { CandleArt, Positions } from './Positions'
import '../styles/portfolio.css'
import '../styles/dashboard.css'

type Totals = { value: number; pnl: number; count: number }

function useMarketsTraded(wallet: string, refreshKey: number) {
  const [n, setN] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchMarketsTraded(wallet)
      .then((v) => !cancelled && setN(v))
      .catch(() => !cancelled && setN(null))
    return () => {
      cancelled = true
    }
  }, [wallet, refreshKey])
  return n
}

/** Public link to a wallet's caller profile. */
export const profileUrl = (wallet: string) => `${window.location.origin}/${routeHref({ name: 'profile', wallet: wallet.toLowerCase() })}`

/** Share a caller profile: the system share sheet where there is one, else copy the link. */
function ShareProfile({ wallet, own }: { wallet: string; own: boolean }) {
  const url = profileUrl(wallet)
  const text = own ? `My calls on ${BRAND.name} 🟢🔴 Yay or nay?` : `A caller on ${BRAND.name} 🟢🔴`
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: `${BRAND.name} caller profile`, text, url })
        return
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      toast({ kind: 'success', title: 'Link copied', detail: 'Anyone with the link sees this caller profile.' })
    } catch {
      toast({ kind: 'error', title: 'Could not copy', detail: url })
    }
  }
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  return (
    <div className="dash-share">
      <button type="button" className="ghost" onClick={share}>
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 10V2.5M5 5.3 8 2.3l3 3M3.5 8.5v4.5h9V8.5" />
        </svg>
        Share profile
      </button>
      <a className="button ghost icon-only" href={intent} target="_blank" rel="noreferrer" aria-label="Post on X" title="Post on X">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path className="fill" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.19L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.2h1.7L7.4 4.73H5.58L16.67 19.2Z" />
        </svg>
      </a>
    </div>
  )
}

/** The portfolio page: value, P&L over time, calling card, open calls, history and activity. */
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
  const { client, polyWallet } = props
  if (!client || !polyWallet) {
    return (
      <div className="pf-page">
        <div className="section-head">
          <div>
            <h1>Portfolio</h1>
            <p className="section-sub">Your calls, their odds right now, and what they pay if you're right.</p>
          </div>
        </div>
        <PortfolioGate connected={props.isConnected} onConnect={props.onConnect} onLink={props.onLink} />
      </div>
    )
  }
  return <PortfolioBody {...props} client={client} polyWallet={polyWallet} />
}

function PortfolioBody(props: Parameters<typeof Portfolio>[0] & { client: PolyClient; polyWallet: `0x${string}` }) {
  const [totals, setTotals] = useState<Totals>({ value: 0, pnl: 0, count: 0 })
  const { client, polyWallet, refreshKey } = props
  const feed = useActivityFeed(polyWallet, props.address, refreshKey)
  const marketsTraded = useMarketsTraded(polyWallet, refreshKey)

  return (
    <div className="pf-page">
      <div className="section-head dash-head">
        <div className="dash-who">
          <CandleSignature address={polyWallet} size={52} />
          <div>
            <h1>Portfolio</h1>
            <p className="section-sub">
              Your calls, live. <a href={routeHref({ name: 'profile', wallet: polyWallet })}>Public profile</a>
            </p>
          </div>
        </div>
        <ShareProfile wallet={polyWallet} own />
      </div>

      <div className="dash-grid">
        <ValueCard cash={props.pusd} showCash positionsValue={totals.value} unrealized={totals.pnl} positions={totals.count} actions />
        <PnlCard wallet={polyWallet} refreshKey={refreshKey} />
      </div>
      <CallingCardStrip items={feed.items} partial={feed.hasMore} marketsTraded={marketsTraded} />

      <Positions
        client={client}
        tradeClient={props.tradeClient}
        wallet={polyWallet}
        refreshKey={refreshKey}
        onPolygon={props.onPolygon}
        onChanged={props.onChanged}
        pusdBalance={props.pusd}
        onTotals={setTotals}
      />
      <CallHistory wallet={polyWallet} refreshKey={refreshKey} />
      <ActivityPanel feed={feed} sub="Trades and claims from Polymarket, plus deposits, withdrawals and top-ups made in this browser." />
    </div>
  )
}

/** A read-only caller profile for any Polymarket wallet: #/u/<wallet>. */
export function Profile({ wallet, ownWallet }: { wallet: string; ownWallet: string | null }) {
  const [value, setValue] = useState<number | null>(null)
  const feed = useActivityFeed(wallet, undefined, 0)
  const marketsTraded = useMarketsTraded(wallet, 0)
  const own = ownWallet?.toLowerCase() === wallet.toLowerCase()

  useEffect(() => {
    let cancelled = false
    fetchPositionsValue(wallet)
      .then((v) => !cancelled && setValue(v))
      .catch(() => !cancelled && setValue(0))
    return () => {
      cancelled = true
    }
  }, [wallet])

  return (
    <div className="pf-page">
      <div className="section-head dash-head">
        <div className="dash-who">
          <CandleSignature address={wallet} size={52} />
          <div>
            <span className="eyebrow">{own ? 'Your caller profile' : 'Caller profile'}</span>
            <h1 className="mono-title">{shortAddress(wallet)}</h1>
            <p className="section-sub">
              Public Polymarket record ·{' '}
              <a href={`https://polymarket.com/profile/${wallet}`} target="_blank" rel="noreferrer">
                Polymarket ↗
              </a>
              {own && (
                <>
                  {' · '}
                  <a href={routeHref({ name: 'portfolio' })}>Your portfolio</a>
                </>
              )}
            </p>
          </div>
        </div>
        <ShareProfile wallet={wallet} own={own} />
      </div>

      <div className="dash-grid">
        <ValueCard cash={null} showCash={false} positionsValue={value ?? 0} unrealized={0} positions={0}>
          <div className="dash-facts">
            <div>
              <span className="pf-split-k">Last active</span>
              <b>{feed.items === null ? '…' : feed.items[0] ? timeAgo(feed.items[0].timestamp) : 'Never'}</b>
            </div>
            <div>
              <span className="pf-split-k">Markets</span>
              <b className="num">{marketsTraded ?? '…'}</b>
            </div>
          </div>
          {!own && (
            <a className="button dash-cta" href={routeHref({ name: 'markets' })}>
              Make your own calls
              <span aria-hidden="true">→</span>
            </a>
          )}
        </ValueCard>
        <PnlCard wallet={wallet} refreshKey={0} />
      </div>
      <CallingCardStrip items={feed.items} partial={feed.hasMore} marketsTraded={marketsTraded} />
      <CallHistory wallet={wallet} refreshKey={0} />
      <ActivityPanel feed={feed} sub="Trades and claims on Polymarket, newest first." />
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
