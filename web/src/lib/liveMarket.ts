import { useEffect, useState, useSyncExternalStore } from 'react'
import { fetchBook, parseBook, type Book, type RawLevel } from './marketData'
import type { Level } from './quote'

// Live market data over Polymarket's public CLOB WebSocket. One shared socket serves every component:
// subscriptions are ref-counted per asset and changed in place with `operation: subscribe | unsubscribe`
// (re-sending the initial `{type: 'market'}` message is rejected with "INVALID OPERATION").
// REST stays the snapshot source and the fallback whenever the socket is down.

export const LIVE_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

export type LiveStatus = 'connecting' | 'live' | 'offline'

/** One level update: `size` is the new aggregate size at `price` ("0" removes it); BUY is the bid side. */
export type PriceChange = { side: 'BUY' | 'SELL'; price: number; size: number }

export type LivePrice = { bid: number | null; ask: number | null; mid: number | null; last: number | null }

export type LiveTrade = {
  assetId: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  /** Unix seconds, like the data API's trades. */
  timestamp: number
  tx?: string
}

// ---------- pure helpers ----------

/** Sets one level's size (0 removes it), keeping the side sorted best first. Returns the same array if nothing changed. */
function setLevel(levels: Level[], price: number, size: number, bestIsHighest: boolean): Level[] {
  const i = levels.findIndex((l) => l.price === price)
  if (i >= 0) {
    if (size > 0 && levels[i].size === size) return levels
    const next = levels.slice()
    if (size > 0) next[i] = { price, size }
    else next.splice(i, 1)
    return next
  }
  if (!(size > 0)) return levels
  const at = levels.findIndex((l) => (bestIsHighest ? l.price < price : l.price > price))
  const next = levels.slice()
  next.splice(at < 0 ? next.length : at, 0, { price, size })
  return next
}

/** Applies `price_change` level updates to a book without mutating it. */
export function applyPriceChanges(book: Book, changes: PriceChange[]): Book {
  let { bids, asks } = book
  for (const c of changes) {
    if (!Number.isFinite(c.price) || !Number.isFinite(c.size)) continue
    if (c.side === 'BUY') bids = setLevel(bids, c.price, c.size, true)
    else asks = setLevel(asks, c.price, c.size, false)
  }
  return bids === book.bids && asks === book.asks ? book : { ...book, bids, asks }
}

const bidOrNull = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 ? n : null)
const askOrNull = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 && n < 1 ? n : null)

export function makePrice(bid: number | null, ask: number | null, last: number | null): LivePrice {
  return { bid, ask, mid: bid !== null && ask !== null ? (bid + ask) / 2 : null, last }
}

/** The price Polymarket shows: the midpoint while the spread is at most 10¢, otherwise the last trade. */
export function displayPrice(p: LivePrice | undefined): number | null {
  if (!p) return null
  if (p.mid !== null && p.bid !== null && p.ask !== null && p.ask - p.bid <= 0.1 + 1e-9) return p.mid
  return p.last
}

// ---------- connection manager ----------

/** The part of the browser WebSocket the manager uses, so tests can pass a fake. */
export type SocketLike = {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type LiveHandlers = {
  /** Book or price of these assets changed (batched, at most once per throttle window). */
  onUpdate?: (assetIds: string[]) => void
  /** New trades on these assets, oldest first (batched). */
  onTrades?: (trades: LiveTrade[]) => void
}

export type LiveOptions = {
  url?: string
  createSocket?: (url: string) => SocketLike
  /** Listener notifications are batched into one per window (~120 messages per 6 s on a busy market). */
  throttleMs?: number
  pingMs?: number
  /** No message (not even PONG) for this long means the socket is dead. */
  staleMs?: number
  /** Close the socket after the tab has been hidden this long; reopen when it is visible again. */
  hiddenCloseMs?: number
  /** Keep the socket this long after the last subscriber leaves, for quick page-to-page navigation. */
  idleCloseMs?: number
  maxBackoffMs?: number
  random?: () => number
  /** Visibility and network hooks; defaults to `document` / `window` when present. */
  env?: { visible(): boolean; listen(onVisibility: () => void, onOnline: () => void): void } | null
}

type Listener = LiveHandlers & { ids: Set<string> }
type Timer = ReturnType<typeof setTimeout>

type RawEvent = {
  event_type?: string
  asset_id?: string
  bids?: RawLevel[]
  asks?: RawLevel[]
  price?: string
  size?: string
  side?: 'BUY' | 'SELL'
  timestamp?: string
  transaction_hash?: string
  price_changes?: RawChange[]
  /** Older price_change shape: one asset per message. */
  changes?: RawChange[]
}
type RawChange = { asset_id?: string; price: string; size: string; side: 'BUY' | 'SELL'; best_bid?: string; best_ask?: string }

function browserEnv(): LiveOptions['env'] {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null
  return {
    visible: () => document.visibilityState === 'visible',
    listen(onVisibility, onOnline) {
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('online', onOnline)
    },
  }
}

export function createLiveMarket(options: LiveOptions = {}) {
  const url = options.url ?? LIVE_WS_URL
  const createSocket =
    options.createSocket ?? (typeof WebSocket === 'undefined' ? null : (u: string) => new WebSocket(u) as unknown as SocketLike)
  const throttleMs = options.throttleMs ?? 250
  const pingMs = options.pingMs ?? 10_000
  const staleMs = options.staleMs ?? 30_000
  const hiddenCloseMs = options.hiddenCloseMs ?? 60_000
  const idleCloseMs = options.idleCloseMs ?? 5_000
  const maxBackoffMs = options.maxBackoffMs ?? 30_000
  const random = options.random ?? Math.random
  const env = options.env === undefined ? browserEnv() : options.env

  const refs = new Map<string, number>()
  const listeners = new Set<Listener>()
  const statusListeners = new Set<() => void>()
  const books = new Map<string, Book>()
  const prices = new Map<string, LivePrice>()
  const dirty = new Set<string>()
  let trades: LiveTrade[] = []

  let ws: SocketLike | null = null
  let open = false
  let sent = new Set<string>()
  let status: LiveStatus = 'offline'
  let attempt = 0
  let paused = false
  let lastMessage = 0
  let envBound = false
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let retryTimer: Timer | undefined
  let syncTimer: Timer | undefined
  let idleTimer: Timer | undefined
  let hiddenTimer: Timer | undefined
  let flushTimer: Timer | undefined
  const stats = { messages: 0, events: 0, flushes: 0, connects: 0 }

  function setStatus(next: LiveStatus) {
    if (status === next) return
    status = next
    for (const f of [...statusListeners]) f()
  }

  function markDirty(id: string) {
    dirty.add(id)
    if (flushTimer === undefined) flushTimer = setTimeout(flush, throttleMs)
  }

  function flush() {
    flushTimer = undefined
    if (dirty.size === 0 && trades.length === 0) return
    stats.flushes++
    const ids = [...dirty]
    const batch = trades
    dirty.clear()
    trades = []
    for (const l of [...listeners]) {
      if (!listeners.has(l)) continue
      const mine = ids.filter((id) => l.ids.has(id))
      if (mine.length) l.onUpdate?.(mine)
      const own = batch.filter((t) => l.ids.has(t.assetId))
      if (own.length) l.onTrades?.(own)
    }
  }

  /** Drops the socket and every cached book: after a gap the deltas no longer line up, the server re-sends snapshots. */
  function teardown() {
    const sock = ws
    ws = null
    open = false
    sent = new Set()
    clearInterval(pingTimer)
    pingTimer = undefined
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null
      try {
        sock.close()
      } catch {
        // already closed
      }
    }
    if (books.size || prices.size) {
      for (const id of new Set([...books.keys(), ...prices.keys()])) markDirty(id)
      books.clear()
      prices.clear()
    }
  }

  const wanted = () => refs.size > 0 && !paused && createSocket !== null

  function scheduleRetry() {
    if (!wanted() || retryTimer !== undefined) return
    const base = Math.min(maxBackoffMs, 1000 * 2 ** attempt)
    attempt++
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      connect()
    }, base / 2 + random() * (base / 2))
  }

  function lost() {
    teardown()
    setStatus('offline')
    scheduleRetry()
  }

  function connect() {
    if (ws || !wanted() || !createSocket) return
    clearTimeout(retryTimer)
    retryTimer = undefined
    let sock: SocketLike
    try {
      sock = createSocket(url)
    } catch {
      setStatus('offline')
      scheduleRetry()
      return
    }
    stats.connects++
    ws = sock
    setStatus('connecting')
    sock.onopen = () => {
      if (ws !== sock) return
      const ids = [...refs.keys()]
      if (ids.length === 0) {
        teardown()
        setStatus('offline')
        return
      }
      sock.send(JSON.stringify({ assets_ids: ids, type: 'market' }))
      sent = new Set(ids)
      open = true
      lastMessage = Date.now()
      setStatus('live')
      pingTimer = setInterval(() => {
        if (Date.now() - lastMessage > staleMs) lost()
        else sock.send('PING')
      }, pingMs)
    }
    sock.onmessage = (ev) => {
      if (ws !== sock) return
      lastMessage = Date.now()
      handle(ev.data)
    }
    sock.onclose = () => ws === sock && lost()
    sock.onerror = () => ws === sock && lost()
  }

  function scheduleSync() {
    if (syncTimer === undefined) syncTimer = setTimeout(sync, 0)
  }

  /** Brings the socket's subscription in line with the ref counts (coalesces mount/unmount churn). */
  function sync() {
    syncTimer = undefined
    if (refs.size === 0) {
      if (idleTimer === undefined && (ws || retryTimer !== undefined)) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined
          if (refs.size > 0) return
          clearTimeout(retryTimer)
          retryTimer = undefined
          attempt = 0
          teardown()
          setStatus('offline')
        }, idleCloseMs)
      }
    } else {
      clearTimeout(idleTimer)
      idleTimer = undefined
      if (!ws && retryTimer === undefined) connect()
    }
    if (!ws || !open) return
    const add = [...refs.keys()].filter((id) => !sent.has(id))
    const remove = [...sent].filter((id) => !refs.has(id))
    if (add.length) ws.send(JSON.stringify({ assets_ids: add, operation: 'subscribe' }))
    if (remove.length) ws.send(JSON.stringify({ assets_ids: remove, operation: 'unsubscribe' }))
    for (const id of add) sent.add(id)
    for (const id of remove) {
      sent.delete(id)
      books.delete(id)
      prices.delete(id)
    }
  }

  function handle(data: unknown) {
    stats.messages++
    if (typeof data !== 'string' || data === 'PONG') return
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return // e.g. "INVALID OPERATION"
    }
    for (const ev of (Array.isArray(msg) ? msg : [msg]) as RawEvent[]) {
      if (ev && typeof ev === 'object') handleEvent(ev)
    }
  }

  function handleEvent(ev: RawEvent) {
    stats.events++
    // Only real market data proves the connection; an error reply ("INVALID OPERATION") or PONG
    // followed by a close must not reset the backoff, or a rejecting server gets hammered.
    if (ev.event_type === 'book' || ev.event_type === 'price_change' || ev.event_type === 'last_trade_price') attempt = 0
    if (ev.event_type === 'book' && ev.asset_id) {
      const id = ev.asset_id
      if (!refs.has(id)) return
      // The event's last_trade_price is per market, not per token (see parseBook); keep our own.
      const last = prices.get(id)?.last ?? null
      const book = parseBook(ev, last)
      books.set(id, book)
      prices.set(id, makePrice(book.bids[0]?.price ?? null, book.asks[0]?.price ?? null, last))
      markDirty(id)
    } else if (ev.event_type === 'price_change') {
      const list = ev.price_changes ?? (ev.changes ?? []).map((c) => ({ ...c, asset_id: ev.asset_id }))
      const byAsset = new Map<string, RawChange[]>()
      for (const c of list) {
        if (!c.asset_id || !refs.has(c.asset_id)) continue
        const group = byAsset.get(c.asset_id)
        if (group) group.push(c)
        else byAsset.set(c.asset_id, [c])
      }
      for (const [id, group] of byAsset) {
        const before = books.get(id)
        const book = before ? applyPriceChanges(before, group.map((c) => ({ side: c.side, price: Number(c.price), size: Number(c.size) }))) : undefined
        if (book) books.set(id, book)
        const tail = group[group.length - 1]
        const prev = prices.get(id)
        const bid = tail.best_bid !== undefined ? bidOrNull(Number(tail.best_bid)) : (book ? bidOrNull(book.bids[0]?.price) : (prev?.bid ?? null))
        const ask = tail.best_ask !== undefined ? askOrNull(Number(tail.best_ask)) : (book ? askOrNull(book.asks[0]?.price) : (prev?.ask ?? null))
        prices.set(id, makePrice(bid, ask, prev?.last ?? null))
        markDirty(id)
      }
    } else if (ev.event_type === 'last_trade_price' && ev.asset_id) {
      const id = ev.asset_id
      const price = Number(ev.price)
      if (!refs.has(id) || !Number.isFinite(price)) return
      const prev = prices.get(id)
      prices.set(id, makePrice(prev?.bid ?? null, prev?.ask ?? null, price))
      const book = books.get(id)
      if (book) books.set(id, { ...book, lastTrade: price })
      const ts = Number(ev.timestamp)
      trades.push({
        assetId: id,
        side: ev.side === 'SELL' ? 'SELL' : 'BUY',
        price,
        size: Number(ev.size) || 0,
        // The socket stamps milliseconds; the data API uses seconds.
        timestamp: Number.isFinite(ts) && ts > 0 ? (ts > 1e12 ? ts / 1000 : ts) : Date.now() / 1000,
        tx: ev.transaction_hash || undefined,
      })
      markDirty(id)
    }
  }

  function onVisibility() {
    if (!env) return
    if (!env.visible()) {
      if (hiddenTimer === undefined) {
        hiddenTimer = setTimeout(() => {
          hiddenTimer = undefined
          paused = true
          clearTimeout(retryTimer)
          retryTimer = undefined
          teardown()
          setStatus('offline')
        }, hiddenCloseMs)
      }
      return
    }
    clearTimeout(hiddenTimer)
    hiddenTimer = undefined
    paused = false
    reconnectNow()
  }

  /** Skips the remaining backoff (tab visible again, network back). */
  function reconnectNow() {
    if (ws || !wanted()) return
    clearTimeout(retryTimer)
    retryTimer = undefined
    attempt = 0
    connect()
  }

  function subscribe(assetIds: string[], handlers: LiveHandlers = {}): () => void {
    const l: Listener = { ...handlers, ids: new Set(assetIds.filter(Boolean)) }
    listeners.add(l)
    for (const id of l.ids) refs.set(id, (refs.get(id) ?? 0) + 1)
    if (!envBound && env) {
      envBound = true
      env.listen(onVisibility, () => reconnectNow())
      if (!env.visible()) onVisibility()
    }
    scheduleSync()
    let done = false
    return () => {
      if (done) return
      done = true
      listeners.delete(l)
      for (const id of l.ids) {
        const n = (refs.get(id) ?? 1) - 1
        if (n > 0) refs.set(id, n)
        else refs.delete(id)
      }
      scheduleSync()
    }
  }

  return {
    subscribe,
    getBook: (assetId: string) => books.get(assetId),
    getPrice: (assetId: string) => prices.get(assetId),
    getStatus: () => status,
    onStatus(cb: () => void) {
      statusListeners.add(cb)
      return () => void statusListeners.delete(cb)
    },
    /** Counters for diagnostics (messages received, events parsed, listener flushes, sockets opened). */
    stats: () => ({ ...stats, assets: refs.size }),
  }
}

export type LiveMarket = ReturnType<typeof createLiveMarket>

/** The app-wide connection. */
export const liveMarket: LiveMarket = createLiveMarket()

export const subscribeAssets = liveMarket.subscribe
export const getLiveBook = liveMarket.getBook
export const getLivePrice = liveMarket.getPrice

if (import.meta.env?.DEV && typeof window !== 'undefined') {
  // Handy when checking the feed from DevTools: `__liveMarket.stats()`.
  ;(window as unknown as { __liveMarket: LiveMarket }).__liveMarket = liveMarket
}

// ---------- hooks ----------

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(liveMarket.onStatus, liveMarket.getStatus, () => 'offline')
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Order book for one token: a REST snapshot first, then the socket's `book` / `price_change` stream.
 * While the socket has no book for it (offline, reconnecting, or the server never sent one) it polls REST.
 */
export function useLiveBook(tokenId: string, pollMs = 5_000): { book: Book | null; error: string; live: boolean; status: LiveStatus } {
  const status = useLiveStatus()
  const [state, setState] = useState<{ id: string; book: Book | null; error: string; live: boolean }>({ id: tokenId, book: null, error: '', live: false })
  const current = state.id === tokenId ? state : { id: tokenId, book: null, error: '', live: false }

  useEffect(() => {
    let cancelled = false
    let restLast: number | null = null
    const fromSocket = () => {
      const live = getLiveBook(tokenId)
      // Until the socket sees a trade on this token, its book has no last price; keep the REST one.
      const book = live && live.lastTrade === null && restLast !== null ? { ...live, lastTrade: restLast } : live
      if (book) setState({ id: tokenId, book, error: '', live: true })
      // Socket dropped its copy: keep showing the last book and let polling take over.
      else setState((s) => (s.id === tokenId && s.live ? { ...s, live: false } : s))
    }
    const unsubscribe = subscribeAssets([tokenId], { onUpdate: fromSocket })
    if (getLiveBook(tokenId)) fromSocket()
    fetchBook(tokenId)
      .then((book) => {
        if (cancelled) return
        restLast = book.lastTrade
        if (getLiveBook(tokenId)) fromSocket()
        else setState({ id: tokenId, book, error: '', live: false })
      })
      .catch((e) => !cancelled && setState((s) => (s.id === tokenId && s.book ? s : { id: tokenId, book: null, error: errorText(e), live: false })))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [tokenId])

  const fed = current.live
  useEffect(() => {
    if (fed) return
    let cancelled = false
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      fetchBook(tokenId)
        .then((book) => !cancelled && !getLiveBook(tokenId) && setState({ id: tokenId, book, error: '', live: false }))
        .catch(() => {}) // keep the last good book
    }, pollMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [fed, tokenId, pollMs])

  return { book: current.book, error: current.error, live: current.live && status === 'live', status }
}

const EMPTY_PRICES: Record<string, LivePrice> = {}

function samePrices(a: Record<string, LivePrice>, b: Record<string, LivePrice>) {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => {
    const x = a[k]
    const y = b[k]
    return !!y && x.bid === y.bid && x.ask === y.ask && x.last === y.last
  })
}

const idsKey = (ids: string[]) => [...new Set(ids.filter(Boolean))].sort().join(',')

/** Live best bid / ask / mid / last trade per token; tokens without live data are absent. */
export function useLivePrices(tokenIds: string[]): Record<string, LivePrice> {
  const key = idsKey(tokenIds)
  const [state, setState] = useState<{ key: string; prices: Record<string, LivePrice> }>({ key, prices: EMPTY_PRICES })
  useEffect(() => {
    if (!key) return
    const ids = key.split(',')
    const read = () => {
      const prices: Record<string, LivePrice> = {}
      for (const id of ids) {
        const p = getLivePrice(id)
        if (p) prices[id] = p
      }
      setState((s) => (s.key === key && samePrices(s.prices, prices) ? s : { key, prices }))
    }
    const unsubscribe = subscribeAssets(ids, { onUpdate: read })
    read()
    return unsubscribe
  }, [key])
  return state.key === key ? state.prices : EMPTY_PRICES
}

/** Trades seen on the socket since mount (newest first, capped), for one or more tokens. */
export function useLiveTrades(tokenIds: string | string[], max = 50): LiveTrade[] {
  const key = idsKey(Array.isArray(tokenIds) ? tokenIds : [tokenIds])
  const [state, setState] = useState<{ key: string; trades: LiveTrade[] }>({ key, trades: [] })
  useEffect(() => {
    if (!key) return
    return subscribeAssets(key.split(','), {
      onTrades: (fresh) =>
        setState((s) => ({ key, trades: [...[...fresh].reverse(), ...(s.key === key ? s.trades : [])].slice(0, max) })),
    })
  }, [key, max])
  return state.key === key ? state.trades : []
}
