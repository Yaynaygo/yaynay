import { useEffect, useMemo, useState } from 'react'
import { BRAND, DECIDED_PRICE } from '../config'
import { CATEGORIES, fetchEventPage, listPositions, listTrendingEvents, peekEvent, type EventPage, type Market, type Outcome, type PmEvent, type Position } from '../lib/markets'
import type { PolyClient } from '../lib/polyAccount'
import { navigate, parseRoute, replaceRoute, routeHref, type Side } from '../lib/router'
import { friendlyError, toast } from '../lib/toast'
import { quoteSell, sellPosition, type SellQuote } from '../lib/sellPosition'
import { track } from '../lib/progress'
import { displayPrice, useLivePrices } from '../lib/liveMarket'
import { AlertButton } from './AlertButton'
import { EventCard, type Pick } from './EventCard'
import { MarketTabs } from './MarketTabs'
import { NewsCard } from './NewsCard'
import { InView } from './InView'
import { SmartMoney } from './SmartMoney'
import { openPick } from '../lib/pick'
import { PriceChart, type ChartSeries } from './PriceChart'
import { TradePanel, type Blocker } from './TradePanel'
import { WatchButton } from './WatchButton'
import { cents, endsLabel, volume } from './format'
import '../styles/market.css'
import type { BalanceDelta } from '../lib/balanceHint'

const pct = (p: number) => `${Math.round(p * 100)}%`
const contested = (p: number) => p > 0.02 && p < DECIDED_PRICE

/** The sub-market a page opens on: the requested one, else the most likely outcome still open. */
function defaultMarket(event: PmEvent, marketId?: string): Market {
  const asked = marketId ? event.markets.find((m) => m.id === marketId) : undefined
  if (asked) return asked
  if (event.markets.length === 1) return event.markets[0]
  const open = event.markets.filter((m) => contested(m.outcomes[0].price))
  return [...(open.length ? open : event.markets)].sort((a, b) => b.outcomes[0].price - a.outcomes[0].price)[0]
}

type Selection = { marketId: string; side: Side; label: string }

/** "Yay 62% · Nay 38%": the crowd's call on the selected market, as a tug-of-war bar. */
function Mood({ market }: { market: Market }) {
  const [yes, no] = market.outcomes
  const change = market.dayChange * 100
  // "Yay"/"Nay" reads well on Yes/No markets; team or Up/Down names speak for themselves.
  const yesNo = /^yes$/i.test(yes.name) && /^no$/i.test(no.name)
  return (
    <div className="mood" aria-label={`${yes.name} ${pct(yes.price)}, ${no.name} ${pct(no.price)}`}>
      <div className="mood-labels">
        <span className="up">
          {yesNo ? <b>Yay</b> : yes.name} <strong className="num">{pct(yes.price)}</strong>
        </span>
        {Math.abs(change) >= 0.5 && (
          <span className={`change ${change > 0 ? 'up' : 'down'}`}>
            {change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)} pts today
          </span>
        )}
        <span className="down">
          <strong className="num">{pct(no.price)}</strong> {yesNo ? <b>Nay</b> : no.name}
        </span>
      </div>
      <div className="mood-bar">
        <span className="mood-yes" style={{ width: `${Math.max(2, Math.min(98, yes.price * 100))}%` }} />
        <span className="mood-no" />
      </div>
    </div>
  )
}

/** Opened → now → closes → resolution, with how much of the market's life has passed. */
function Timeline({ event, market }: { event: PmEvent; market: Market }) {
  const start = event.startDate ? Date.parse(event.startDate) : NaN
  const end = market.endDate ? Date.parse(market.endDate) : NaN
  const known = Number.isFinite(start) && Number.isFinite(end) && end > start
  const progress = known ? Math.min(1, Math.max(0, (Date.now() - start) / (end - start))) : 0
  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return (
    <div className="timeline">
      <div className="timeline-track">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <ol>
        <li className="done">
          <b>Opened</b>
          <span>{Number.isFinite(start) ? day(start) : '—'}</span>
        </li>
        <li className={progress < 1 ? 'now' : 'done'}>
          <b>Trading</b>
          <span>{progress < 1 ? 'Live now' : 'Closed'}</span>
        </li>
        <li className={progress >= 1 ? 'now' : ''}>
          <b>Closes</b>
          <span>{Number.isFinite(end) ? day(end) : '—'}</span>
        </li>
        <li>
          <b>Resolves</b>
          <span>UMA oracle, ≥ 2h after</span>
        </li>
      </ol>
    </div>
  )
}

function Rules({ event, market }: { event: PmEvent; market: Market }) {
  const [open, setOpen] = useState(false)
  const text = market.description || event.description || 'See the full rules on Polymarket.'
  const source = market.resolutionSource
  return (
    <section className="card mp-rules">
      <h2>Rules</h2>
      <p className={`rules-text${open ? ' open' : ''}`}>{text}</p>
      {text.length > 360 && (
        <button className="link" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
      {source && (
        <div className="kv">
          <span className="k">Resolution source</span>
          <span className="rules-source">
            {/^https?:\/\//.test(source) ? (
              <a href={source} target="_blank" rel="noreferrer">
                {source.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}
              </a>
            ) : (
              source
            )}
          </span>
        </div>
      )}
      <Timeline event={event} market={market} />
      <p className="muted">
        Polymarket resolves markets through the UMA optimistic oracle. After a result is proposed there is a 2-hour
        challenge window; disputed results can take a few more days.
      </p>
    </section>
  )
}

type SellState =
  | { step: 'quoting' }
  | { step: 'confirm'; quote: SellQuote }
  | { step: 'selling'; text: string }
  | { step: 'done' | 'error'; text: string }

function YourPosition(props: {
  wallet: string
  event: PmEvent
  refreshKey: number
  client: PolyClient | null
  tradeClient: PolyClient | null
  pusdBalance: string | null
  onPolygon: () => Promise<void>
  onSold: (delta?: BalanceDelta) => void
}) {
  const { wallet, event, refreshKey } = props
  const [positions, setPositions] = useState<Position[] | null>(null)
  const [sell, setSell] = useState<Record<string, SellState>>({})
  // Sold positions stay hidden until the Data API stops reporting them.
  const [gone, setGone] = useState<Set<string>>(() => new Set())
  const conditions = useMemo(() => new Set(event.markets.map((m) => m.conditionId)), [event])
  useEffect(() => {
    let cancelled = false
    listPositions(wallet)
      .then((all) => !cancelled && setPositions(all.filter((p) => conditions.has(p.conditionId))))
      .catch(() => !cancelled && setPositions([]))
    return () => {
      cancelled = true
    }
  }, [wallet, conditions, refreshKey])
  const shown = (positions ?? []).filter((p) => !gone.has(p.asset) || sell[p.asset]?.step === 'done')
  if (shown.length === 0) return null

  const set = (asset: string, st: SellState | null) =>
    setSell((prev) => {
      const next = { ...prev }
      if (st) next[asset] = st
      else delete next[asset]
      return next
    })

  async function start(p: Position) {
    set(p.asset, { step: 'quoting' })
    try {
      const quote = await quoteSell(p)
      set(p.asset, quote ? { step: 'confirm', quote } : { step: 'error', text: 'No buyers for this outcome right now. You can hold it until the market resolves.' })
    } catch (e) {
      set(p.asset, { step: 'error', text: friendlyError(e) })
    }
  }

  async function confirm(p: Position, quote: SellQuote) {
    if (!props.client) return
    const before = props.pusdBalance
    set(p.asset, { step: 'selling', text: 'Preparing the sell order…' })
    try {
      const res = await sellPosition(p, quote, {
        client: props.client,
        tradeClient: props.tradeClient,
        onPolygon: props.onPolygon,
        onStatus: (text) => set(p.asset, { step: 'selling', text }),
      })
      track('sell_done', { slug: event.slug })
      if (res.sold < quote.shares - 0.01) {
        // Fill-and-kill filled only part of it: keep the row and its Sell button for the rest.
        const left = quote.shares - res.sold
        set(p.asset, {
          step: 'error',
          text: `Sold ${res.sold.toFixed(2)} shares for $${res.received.toFixed(2)}. ${left.toFixed(2)} are left because the buyers ran out at this price; Sell all again to try the rest.`,
        })
      } else {
        set(p.asset, { step: 'done', text: `Sold ${res.sold.toFixed(2)} shares for $${res.received.toFixed(2)}.` })
        setGone((g) => new Set(g).add(p.asset))
      }
      toast({ kind: 'success', title: 'Cashed out', detail: `Sold ${res.sold.toFixed(2)} ${p.outcome} shares for $${res.received.toFixed(2)}. ${p.title}` })
      props.onSold(res.received > 0 ? { pusd: { delta: res.received, before } } : undefined)
    } catch (e) {
      set(p.asset, { step: 'error', text: friendlyError(e) })
    }
  }

  return (
    <section className="card mp-position">
      <div className="eyebrow accent">Your calls here</div>
      {shown.map((p) => {
        const yay = !/^(no|down)$/i.test(p.outcome)
        const st = sell[p.asset]
        const busy = st?.step === 'quoting' || st?.step === 'selling'
        return (
          <div className="pos-item" key={p.asset}>
            <div className="pos-line">
              <span className={`badge ${yay ? 'yes' : 'no'}`}>{p.outcome}</span>
              <span className="grow">
                <span className="num">{p.size.toFixed(2)}</span> shares @ {cents(p.avgPrice)}
                {event.markets.length > 1 && <span className="muted"> · {p.title}</span>}
              </span>
              <span className="num">${p.currentValue.toFixed(2)}</span>
              <span className={`num ${p.cashPnl >= 0 ? 'up' : 'down'}`}>
                {p.cashPnl >= 0 ? '+' : '−'}${Math.abs(p.cashPnl).toFixed(2)}
              </span>
            </div>
            {st?.step === 'confirm' ? (
              <div className="pos-confirm">
                <span>
                  Sell <b className="num">{st.quote.shares.toFixed(2)}</b> shares at about <b>{cents(st.quote.bestBid)}</b> ≈{' '}
                  <b className="num">${st.quote.estimate.toFixed(2)}</b>
                  <small className="muted"> (never below {cents(Number(st.quote.minPrice))})</small>
                </span>
                <span className="pos-actions">
                  <button className="no" onClick={() => confirm(p, st.quote)}>
                    Confirm sell
                  </button>
                  <button className="ghost" onClick={() => set(p.asset, null)}>
                    Cancel
                  </button>
                </span>
              </div>
            ) : st?.step === 'done' ? null : p.redeemable ? (
              <a className="pos-link" href={routeHref({ name: 'portfolio' })}>
                Resolved: claim in Portfolio →
              </a>
            ) : props.client ? (
              <div className="pos-actions">
                <button className="subtle" disabled={busy} onClick={() => start(p)}>
                  {st?.step === 'quoting' ? 'Checking the book…' : st?.step === 'selling' ? 'Selling…' : 'Sell all'}
                </button>
              </div>
            ) : (
              <a className="pos-link" href={routeHref({ name: 'portfolio' })}>
                Sell or manage in Portfolio →
              </a>
            )}
            {st && (st.step === 'selling' || st.step === 'done' || st.step === 'error') && (
              <div className={`notice ${st.step === 'error' ? 'err' : st.step === 'done' ? 'ok' : 'info'}`} role={st.step === 'error' ? 'alert' : 'status'}>
                {st.text}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}

function Related({ event }: { event: PmEvent }) {
  const [events, setEvents] = useState<PmEvent[]>([])
  const tag = event.tags.find((t) => CATEGORIES.some((c) => c.slug === t.slug))?.slug ?? event.tags[0]?.slug ?? ''
  useEffect(() => {
    let cancelled = false
    listTrendingEvents(tag, 'trending', 10)
      .then((list) => !cancelled && setEvents(list.filter((e) => e.slug !== event.slug).slice(0, 3)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [tag, event.slug])
  if (events.length === 0) return null
  return (
    <section className="mp-related">
      <h2>More calls like this</h2>
      <div className="grid">
        {events.map((e) => (
          <EventCard key={e.id} event={e} onPick={openPick} />
        ))}
      </div>
    </section>
  )
}

export function MarketPage(props: {
  slug: string
  marketId?: string
  side?: Side
  client: PolyClient | null
  tradeClient: PolyClient | null
  canBuy: boolean
  blocker: Blocker | null
  pusdBalance: string | null
  wallet: string | null
  refreshKey: number
  onPolygon: () => Promise<void>
  onTraded: (delta?: BalanceDelta) => void
}) {
  const cached = peekEvent(props.slug)
  const [page, setPage] = useState<EventPage | null>(cached ? { status: 'open', event: cached } : null)
  const [loadError, setLoadError] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [sheet, setSheet] = useState(false)

  // The side panel sticks beside the chart only while all of it fits in the window (warnings can make
  // it taller), so the Buy button never ends up below the fold.
  const [side, setSide] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!side) return
    const check = () => side.classList.toggle('fits', side.scrollHeight <= window.innerHeight - 100)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(side)
    window.addEventListener('resize', check)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', check)
    }
  }, [side])

  // Load, then refresh the event now and then; prices in between come from the live feed.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetchEventPage(props.slug)
        .then((p) => {
          if (cancelled) return
          setPage(p)
          setLoadError('')
        })
        .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)))
    load()
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [props.slug])

  const event = page?.status === 'open' ? page.event : null

  // Selection follows the URL (shared links, Back), then the user's clicks. Clicks rewrite the URL without
  // a re-route, so the params are read from the address bar itself: props can be one click behind it.
  const hash = window.location.hash
  useEffect(() => {
    if (!event) return
    const now = parseRoute(window.location.hash)
    const marketId = now.name === 'market' ? now.marketId : props.marketId
    const side = now.name === 'market' ? now.side : props.side
    const m = defaultMarket(event, marketId)
    setSelection((prev) =>
      prev && prev.marketId === m.id && prev.side === (side ?? 'yes') ? prev : { marketId: m.id, side: side ?? 'yes', label: m.label },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id, props.marketId, props.side, hash])

  // Live prices for what is on screen: the outcome rows shown (or the single market) plus the selected one.
  const liveTokens = useMemo(() => {
    if (!event) return []
    const shown = event.markets.length > 1 ? [...event.markets].sort((a, b) => b.outcomes[0].price - a.outcomes[0].price).slice(0, showAll ? undefined : 8) : event.markets
    const chosen = selection ? event.markets.find((m) => m.id === selection.marketId) : undefined
    return [...shown, ...(chosen ? [chosen] : [])].flatMap((m) => m.outcomes.slice(0, 2).map((o) => o.tokenId))
  }, [event, showAll, selection])
  const livePrices = useLivePrices(liveTokens)

  // The chart's lines are the leading options when the page opened; re-ranking on every price refresh
  // would reset the chart whenever two close options swap places.
  const topIds = useMemo(
    () => (event ? [...event.markets].sort((a, b) => b.outcomes[0].price - a.outcomes[0].price).slice(0, 4).map((m) => m.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event?.id],
  )

  useEffect(() => {
    if (!event) return
    document.title = `${event.title} · ${BRAND.name}`
    track('market_viewed', { slug: event.slug, category: event.tags[0]?.slug })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id])

  if (loadError && !page) {
    return (
      <div className="card empty mp-missing">
        <h2>Couldn't load this market</h2>
        <p className="sub">{loadError}</p>
        <button onClick={() => window.location.reload()}>Try again</button>
      </div>
    )
  }
  if (!page) return <MarketSkeleton />
  if (page.status !== 'open') {
    return (
      <div className="card empty mp-missing">
        {page.status === 'closed' && page.image && <img className="event-img lg" src={page.image} alt="" />}
        <h2>{page.status === 'closed' ? page.title : 'Market not found'}</h2>
        <p className="sub">
          {page.status === 'closed'
            ? 'This market has closed or is effectively decided, so it no longer takes orders here.'
            : 'The link may be mistyped, or the market was removed.'}
        </p>
        <div className="mp-missing-actions">
          <button onClick={() => navigate({ name: 'markets' })}>Browse open markets</button>
          {page.status === 'closed' && (
            <a className="button ghost" href={`https://polymarket.com/event/${page.slug}`} target="_blank" rel="noreferrer">
              See the result on Polymarket ↗
            </a>
          )}
        </div>
      </div>
    )
  }

  const ev = page.event
  const selected = selection ? ev.markets.find((m) => m.id === selection.marketId) : undefined
  // The chosen option dropped out on a refresh (decided or paused): say so instead of quietly arming another one.
  const gone = selection && !selected ? selection : null
  const market = selected ?? defaultMarket(ev, props.marketId)
  const outcome: Outcome = selection?.side === 'no' ? market.outcomes[1] : market.outcomes[0]
  const multi = ev.markets.length > 1
  const ranked = [...ev.markets].sort((a, b) => b.outcomes[0].price - a.outcomes[0].price)
  const visible = showAll ? ranked : ranked.slice(0, 8)

  const select = (m: Market, side: Side, openSheet = false) => {
    setSelection({ marketId: m.id, side, label: m.label })
    replaceRoute({ name: 'market', slug: ev.slug, marketId: multi ? m.id : undefined, side: side === 'no' ? 'no' : undefined })
    // Phones trade in a bottom sheet; on wider screens the docked panel beside the chart follows the selection.
    if (openSheet && window.matchMedia('(max-width: 900px)').matches) setSheet(true)
  }
  const onOutcome = (o: Outcome) => select(market, o.tokenId === market.outcomes[1].tokenId ? 'no' : 'yes')

  const lines = topIds.map((id) => ev.markets.find((m) => m.id === id)).filter((m): m is Market => !!m)
  const series: ChartSeries[] = multi
    ? [...lines, ...(lines.includes(market) ? [] : [market])].map((m) => ({ tokenId: m.outcomes[0].tokenId, label: m.label }))
    : [{ tokenId: market.outcomes[0].tokenId, label: market.outcomes[0].name }]

  // Display only: the trade panel keeps the REST objects and re-quotes from the book itself.
  const px = (o: Outcome) => displayPrice(livePrices[o.tokenId]) ?? o.price
  const shownMarket: Market = { ...market, outcomes: market.outcomes.map((o) => ({ ...o, price: px(o) })) }
  const livePrice = multi ? undefined : (displayPrice(livePrices[market.outcomes[0].tokenId]) ?? undefined)

  const pick: Pick = { event: ev, market, outcome }
  const end = market.endDate ?? ev.endDate
  const category = ev.tags.find((t) => CATEGORIES.some((c) => c.slug === t.slug))

  async function share() {
    const route = { name: 'market', slug: ev.slug, marketId: multi ? market.id : undefined, side: outcome === market.outcomes[1] ? 'no' : undefined } as const
    const url = `${window.location.origin}${window.location.pathname}${routeHref(route)}`
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: ev.title, url })
      else {
        await navigator.clipboard.writeText(url)
        toast({ kind: 'info', title: 'Link copied', detail: 'Share it: the page opens straight on this market.' })
      }
      track('share_copied', { slug: ev.slug })
    } catch {
      // Share sheet dismissed.
    }
  }

  const tradeProps = {
    pick,
    client: props.client,
    tradeClient: props.tradeClient,
    canBuy: props.canBuy,
    blocker: props.blocker,
    pusdBalance: props.pusdBalance,
    onPolygon: props.onPolygon,
    onTraded: (delta?: BalanceDelta) => {
      track('trade_done', { slug: ev.slug })
      if (multi) track('multi_trade_done', { slug: ev.slug })
      props.onTraded(delta)
    },
    onOutcomeChange: onOutcome,
  }

  return (
    <div className="mp">
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href={routeHref({ name: 'markets' })}>
          ← Markets
        </a>
        {category && (
          <>
            <span aria-hidden="true">/</span>
            <span>{category.label}</span>
          </>
        )}
      </nav>

      <header className="mp-head">
        {ev.image ? <img className="mp-img" src={ev.image} alt="" /> : <div className="mp-img" />}
        <div className="mp-title">
          <h1>{ev.title}</h1>
          <div className="mp-meta">
            <span>
              <b>{volume(ev.volume)}</b> volume
            </span>
            <span>
              <b>{volume(ev.volume24hr)}</b> today
            </span>
            {ev.liquidity > 0 && (
              <span>
                <b>{volume(ev.liquidity)}</b> liquidity
              </span>
            )}
            {end && <span>{endsLabel(end)}</span>}
          </div>
        </div>
        <div className="mp-actions">
          <WatchButton slug={ev.slug} title={ev.title} image={ev.image} />
          <button className="subtle" onClick={share} aria-label="Share this market">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14" />
            </svg>
            Share
          </button>
          <a className="button subtle" href={`https://polymarket.com/event/${ev.slug}`} target="_blank" rel="noreferrer">
            Polymarket ↗
          </a>
        </div>
      </header>

      <div className="mp-grid">
        <div className="mp-main">
          <section className="card mp-chart">
            {multi && <div className="mp-chart-label">{market.label}</div>}
            <Mood market={shownMarket} />
            <PriceChart
              key={series.map((s) => s.tokenId).join()}
              series={series}
              livePrice={livePrice}
              onRangeChange={() => track('chart_range_changed', { slug: ev.slug })}
              onModeChange={(m) => m === 'candles' && track('chart_candles', { slug: ev.slug })}
            />
            <div className="mp-chart-foot">
              <span className="muted">Prices are the crowd's odds: 62¢ ≈ 62% chance. Each share pays $1 if it happens.</span>
              <AlertButton tokenId={outcome.tokenId} outcome={outcome.name} title={multi ? `${ev.title} · ${market.label}` : ev.title} slug={ev.slug} price={outcome.price} />
            </div>
          </section>

          {multi && (
            <section className="card mp-outcomes">
              <div className="mp-outcomes-head">
                <h2>Outcomes</h2>
                <span className="muted">{ev.markets.length} options · tap one to trade it</span>
              </div>
              <div role="list">
                {visible.map((m) => {
                  const on = m.id === market.id
                  const change = m.dayChange * 100
                  return (
                    <div role="listitem" key={m.id} className={`mo-row${on ? ' on' : ''}`} onClick={() => select(m, 'yes')}>
                      <div className="mo-name">
                        <span title={m.label}>{m.label}</span>
                        <small className="mono">{volume(m.volume)} vol</small>
                      </div>
                      <div className="mo-pct">
                        <span className="num">{pct(px(m.outcomes[0]))}</span>
                        {Math.abs(change) >= 1 && (
                          <small className={change > 0 ? 'up' : 'down'}>
                            {change > 0 ? '▲' : '▼'}
                            {Math.abs(change).toFixed(0)}
                          </small>
                        )}
                      </div>
                      <div className="mo-picks">
                        <button
                          className={`pick yes${on && outcome.tokenId === m.outcomes[0].tokenId ? ' sel' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            select(m, 'yes', true)
                          }}
                        >
                          Yes {cents(px(m.outcomes[0]))}
                        </button>
                        <button
                          className={`pick no${on && outcome.tokenId === m.outcomes[1].tokenId ? ' sel' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            select(m, 'no', true)
                          }}
                        >
                          No {cents(px(m.outcomes[1]))}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              {ranked.length > 8 && (
                <button className="link more" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show all ${ranked.length} outcomes`}
                </button>
              )}
            </section>
          )}

          <MarketTabs
            market={market}
            outcome={outcome}
            onOutcome={onOutcome}
            onBookSeen={() => track('book_viewed', { slug: ev.slug })}
          />
          <InView minHeight={260}>
            <NewsCard key={ev.slug} title={ev.title} />
          </InView>
          <InView minHeight={220}>
            <SmartMoney
              key={market.conditionId}
              conditionId={market.conditionId}
              outcomes={market.outcomes.map((o) => ({ name: o.name, tokenId: o.tokenId }))}
            />
          </InView>
          <Rules event={ev} market={market} />
        </div>

        <div className="mp-side" ref={setSide}>
          {gone ? (
            <section className="card mp-gone" role="status">
              <div className="eyebrow">Make your call</div>
              <h2>{gone.label} stopped trading</h2>
              <p className="sub">It is effectively decided or paused, so it no longer takes orders here.</p>
              <button onClick={() => select(market, 'yes')}>Trade {market.label} instead</button>
            </section>
          ) : (
            // The drawer replaces the dock while it is open, so only one panel quotes and holds the form.
            !sheet && <TradePanel key={market.id} variant="dock" {...tradeProps} />
          )}
          {props.wallet && (
            <YourPosition
              wallet={props.wallet}
              event={ev}
              refreshKey={props.refreshKey}
              client={props.client}
              tradeClient={props.tradeClient}
              pusdBalance={props.pusdBalance}
              onPolygon={props.onPolygon}
              onSold={props.onTraded}
            />
          )}
        </div>
      </div>

      <Related event={ev} />

      <div className="mp-bar" role="group" aria-label="Quick trade">
        {market.outcomes.slice(0, 2).map((o, i) => (
          <button key={o.tokenId} className={`pick ${i === 0 ? 'yes' : 'no'}`} onClick={() => select(market, i === 0 ? 'yes' : 'no', true)}>
            {o.name} {cents(px(o))}
          </button>
        ))}
      </div>
      {sheet && !gone && <TradePanel key={`sheet-${market.id}`} variant="drawer" {...tradeProps} onClose={() => setSheet(false)} />}
    </div>
  )
}

function MarketSkeleton() {
  return (
    <div className="mp" aria-busy="true">
      <div className="skeleton" style={{ height: 88, marginBottom: 18 }} />
      <div className="mp-grid">
        <div className="mp-main">
          <div className="skeleton" style={{ height: 420 }} />
          <div className="skeleton" style={{ height: 320 }} />
        </div>
        <div className="mp-side">
          <div className="skeleton" style={{ height: 520 }} />
        </div>
      </div>
    </div>
  )
}
