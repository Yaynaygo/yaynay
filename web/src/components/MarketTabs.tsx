import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Market, Outcome } from '../lib/markets'
import { ago, depth, fetchHolders, fetchMarketTrades, type Book, type Holder, type MarketTrade } from '../lib/marketData'
import { useLiveBook, useLiveStatus, useLiveTrades, type LiveStatus } from '../lib/liveMarket'
import { explorer } from '../config'
import { cents } from './format'

type Tab = 'book' | 'trades' | 'holders'

/**
 * Loads `load` for `key`, then every `ms` while the tab is visible; keeps the last good value on errors.
 * `run` refetches now; changing `ms` keeps the data.
 */
function usePolling<T>(load: () => Promise<T>, ms: number, key: string) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({ key, data: null, error: '' })
  const loadRef = useRef(load)
  const keyRef = useRef(key)
  useEffect(() => {
    loadRef.current = load
    keyRef.current = key
  })
  const lastRun = useRef(0)
  const run = useCallback(() => {
    if (document.visibilityState !== 'visible') return
    const k = keyRef.current
    lastRun.current = Date.now()
    loadRef
      .current()
      .then((data) => k === keyRef.current && setState({ key: k, data, error: '' }))
      .catch((e) => k === keyRef.current && setState((s) => ({ key: k, data: s.key === k ? s.data : null, error: e instanceof Error ? e.message : String(e) })))
  }, [])
  useEffect(run, [key, run])
  useEffect(() => {
    const id = setInterval(run, ms)
    document.addEventListener('visibilitychange', run)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', run)
    }
  }, [ms, run])
  const current = state.key === key ? state : { data: null, error: '' }
  return { data: current.data, error: current.error, run, lastRun }
}

/** "Live" while the socket feeds this view, "Delayed" while it falls back to polling. */
function LiveBadge({ live, status }: { live: boolean; status: LiveStatus }) {
  const state = live ? 'live' : status === 'connecting' ? 'connecting' : 'delayed'
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Delayed'
  const title =
    state === 'live' ? 'Streaming from Polymarket' : state === 'connecting' ? 'Connecting to the live feed' : 'Live feed unavailable; refreshing every few seconds'
  return (
    <span className={`live-badge ${state}`} title={title}>
      <span className="live-badge-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

type Flashes = { bids: Set<number>; asks: Set<number> }
const NO_FLASH: Flashes = { bids: new Set(), asks: new Set() }

/** Price levels whose size changed (or appeared) between two books. */
function changedLevels(prev: Book | null, next: Book | null): Flashes {
  if (!prev || !next) return NO_FLASH
  const diff = (a: Book['bids'], b: Book['bids']) => {
    const old = new Map(a.map((l) => [l.price, l.size]))
    return new Set(b.filter((l) => old.get(l.price) !== l.size).map((l) => l.price))
  }
  return { bids: diff(prev.bids, next.bids), asks: diff(prev.asks, next.asks) }
}

/** Price in cents with as many decimals as the market's tick needs (0.001 ticks → "84.1¢"). */
const tickCents = (price: number, tick: number) => `${(price * 100).toFixed(Math.max(0, Math.round(-Math.log10(tick)) - 2))}¢`
const shares = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n >= 100 ? n.toFixed(0) : n.toFixed(2))
const usd = (n: number) => (n >= 10_000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(n >= 100 ? 0 : 2)}`)

function OrderBook({ outcome, isFirst, tick }: { outcome: Outcome; isFirst: boolean; tick: number }) {
  const { book, error, live, status } = useLiveBook(outcome.tokenId)
  // Remember which levels moved since the previous book so they can flash (state derived during render).
  const [seen, setSeen] = useState<{ book: Book | null; flashes: Flashes }>({ book, flashes: NO_FLASH })
  if (seen.book !== book) setSeen({ book, flashes: changedLevels(seen.book, book) })
  const flashes = seen.book === book ? seen.flashes : NO_FLASH
  if (error && !book) return <div className="notice err">Order book unavailable: {error}</div>
  if (!book) return <div className="skeleton" style={{ height: 300 }} />

  const asks = depth(book.asks, 7)
  const bids = depth(book.bids, 7)
  const max = Math.max(asks.at(-1)?.cumulative ?? 0, bids.at(-1)?.cumulative ?? 0, 1)
  const bestAsk = book.asks[0]?.price
  const bestBid = book.bids[0]?.price
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : null

  return (
    <div className="ob" aria-label={`Order book for ${outcome.name}`}>
      <div className="ob-row ob-head">
        <span className="ob-price">Price</span>
        <span>Shares</span>
        <span>Total</span>
      </div>
      <div className="ob-side asks">
        {asks.length === 0 && <div className="ob-empty">No sellers right now</div>}
        {[...asks].reverse().map((l) => (
          <div className="ob-row" key={`a${l.price}`}>
            {flashes.asks.has(l.price) && <span className="ob-flash" key={l.size} />}
            <span className="ob-bar" style={{ width: `${(l.cumulative / max) * 100}%` }} />
            <span className="ob-price">{tickCents(l.price, tick)}</span>
            <span className="num">{shares(l.size)}</span>
            <span className="num">{usd(l.total)}</span>
          </div>
        ))}
      </div>
      <div className="ob-mid">
        <span>
          <b className={isFirst ? 'up' : 'down'}>{outcome.name}</b> shares <LiveBadge live={live} status={status} />
        </span>
        <span className="mono">
          {book.lastTrade !== null && <>Last {tickCents(book.lastTrade, tick)} · </>}
          Spread {spread !== null ? tickCents(Math.max(0, spread), tick) : '—'}
        </span>
      </div>
      <div className="ob-side bids">
        {bids.length === 0 && <div className="ob-empty">No buyers right now</div>}
        {bids.map((l) => (
          <div className="ob-row" key={`b${l.price}`}>
            {flashes.bids.has(l.price) && <span className="ob-flash" key={l.size} />}
            <span className="ob-bar" style={{ width: `${(l.cumulative / max) * 100}%` }} />
            <span className="ob-price">{tickCents(l.price, tick)}</span>
            <span className="num">{shares(l.size)}</span>
            <span className="num">{usd(l.total)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Stable row keys: one transaction can fill several orders, so repeats get a suffix. */
function tradeKeys(trades: MarketTrade[]): string[] {
  const seen = new Map<string, number>()
  return trades.map((t) => {
    const base = `${t.tx ?? ''}-${t.timestamp}-${t.outcomeIndex}-${t.size}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}#${n}` : base
  })
}

function Trades({ market }: { market: Market }) {
  const live = useLiveStatus() === 'live'
  // REST carries trader names and history; while the socket streams, it only needs an occasional refresh.
  const { data, error, run, lastRun } = usePolling<MarketTrade[]>(() => fetchMarketTrades(market.conditionId), live ? 60_000 : 15_000, market.conditionId)
  const liveTrades = useLiveTrades(market.outcomes.map((o) => o.tokenId))

  // Fresh trades on the socket: pull names from REST, at most every 10 s.
  const newest = liveTrades[0]
  useEffect(() => {
    if (!newest) return
    const timer = setTimeout(run, Math.max(0, lastRun.current + 10_000 - Date.now()))
    return () => clearTimeout(timer)
  }, [newest, run, lastRun])

  const rows = useMemo(() => {
    if (!data) return null
    const known = new Set(data.map((t) => t.tx).filter(Boolean))
    // The data API stamps trades with the block time, a few seconds after the socket does.
    const since = data.reduce((m, t) => Math.max(m, t.timestamp), 0) - 5
    // Socket trades the REST list does not have yet, shown anonymously until the next refresh names them.
    // Anything older than the REST list's newest trade is either in it or has scrolled past its window.
    const fresh: MarketTrade[] = []
    for (const t of liveTrades) {
      const outcomeIndex = market.outcomes.findIndex((o) => o.tokenId === t.assetId)
      if (outcomeIndex < 0 || (t.tx && known.has(t.tx)) || t.timestamp < since) continue
      fresh.push({ side: t.side, outcome: market.outcomes[outcomeIndex].name, outcomeIndex, size: t.size, price: t.price, who: 'Someone', timestamp: t.timestamp, tx: t.tx })
    }
    return [...fresh, ...data]
  }, [data, liveTrades, market])

  if (error && !rows) return <div className="notice err">Trades unavailable: {error}</div>
  if (!rows) return <div className="skeleton" style={{ height: 300 }} />
  if (rows.length === 0) return <div className="empty">No trades yet. Be the first call.</div>
  const keys = tradeKeys(rows)
  return (
    <ul className="tape">
      {rows.map((t, i) => {
        const yay = t.outcomeIndex === 0
        return (
          <li key={keys[i]}>
            <span className={`tape-dot ${yay ? 'yes' : 'no'}`} aria-hidden="true" />
            <span className="tape-who" title={t.who}>
              {t.who}
            </span>
            <span className="tape-what">
              {t.side === 'BUY' ? 'bought' : 'sold'} <b className={yay ? 'up' : 'down'}>{t.outcome}</b> at {cents(t.price)}
            </span>
            <span className="num tape-usd">{usd(t.size * t.price)}</span>
            {t.tx ? (
              <a className="tape-ago mono" href={explorer.polygonTx(t.tx)} target="_blank" rel="noreferrer" title="View on Polygon">
                {ago(t.timestamp)}
              </a>
            ) : (
              <span className="tape-ago mono">{ago(t.timestamp)}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Holders({ market }: { market: Market }) {
  const { data, error } = usePolling<Record<number, Holder[]>>(() => fetchHolders(market.conditionId), 60_000, market.conditionId)
  if (error && !data) return <div className="notice err">Holders unavailable: {error}</div>
  if (!data) return <div className="skeleton" style={{ height: 300 }} />
  return (
    <div className="holders">
      {market.outcomes.slice(0, 2).map((o, i) => (
        <div key={o.tokenId}>
          <div className={`holders-head ${i === 0 ? 'up' : 'down'}`}>{o.name} holders</div>
          <ol>
            {(data[i] ?? []).map((h, rank) => (
              <li key={`${h.who}-${rank}`}>
                <span className="rank mono">{rank + 1}</span>
                <span className="who" title={h.who}>
                  {h.who}
                </span>
                <span className="num">{shares(h.amount)}</span>
              </li>
            ))}
            {(data[i] ?? []).length === 0 && <li className="muted">Nobody yet</li>}
          </ol>
        </div>
      ))}
    </div>
  )
}

/** Order book, live trades and top holders of the selected market. */
export function MarketTabs(props: {
  market: Market
  outcome: Outcome
  onOutcome: (o: Outcome) => void
  /** Called once the order book has been on screen for a moment. */
  onBookSeen?: () => void
}) {
  const [tab, setTab] = useState<Tab>('book')
  const card = useRef<HTMLElement>(null)
  const onBookSeen = useRef(props.onBookSeen)
  useEffect(() => {
    onBookSeen.current = props.onBookSeen
  })
  useEffect(() => {
    const el = card.current
    if (tab !== 'book' || !el || typeof IntersectionObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const io = new IntersectionObserver(
      ([entry]) => {
        clearTimeout(timer)
        if (entry.isIntersecting) timer = setTimeout(() => onBookSeen.current?.(), 1500)
      },
      { threshold: 0.6 },
    )
    io.observe(el)
    return () => {
      clearTimeout(timer)
      io.disconnect()
    }
  }, [tab])
  const isFirst = props.outcome.tokenId === props.market.outcomes[0].tokenId
  const tabs: { id: Tab; label: string }[] = [
    { id: 'book', label: 'Order book' },
    { id: 'trades', label: 'Live trades' },
    { id: 'holders', label: 'Top holders' },
  ]
  return (
    <section className="card mp-tabs" ref={card}>
      <div className="mp-tabs-head">
        <div className="seg-tabs" role="tablist" aria-label="Market data">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'on' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'book' && (
          <div className="side-toggle" role="group" aria-label="Outcome">
            {props.market.outcomes.slice(0, 2).map((o, i) => (
              <button
                key={o.tokenId}
                className={o.tokenId === props.outcome.tokenId ? (i === 0 ? 'on-yes' : 'on-no') : ''}
                aria-pressed={o.tokenId === props.outcome.tokenId}
                onClick={() => props.onOutcome(o)}
              >
                {o.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div role="tabpanel">
        {tab === 'book' && <OrderBook outcome={props.outcome} isFirst={isFirst} tick={props.market.tickSize} />}
        {tab === 'trades' && <Trades market={props.market} />}
        {tab === 'holders' && <Holders market={props.market} />}
      </div>
    </section>
  )
}
