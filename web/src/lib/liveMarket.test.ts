import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPriceChanges, createLiveMarket, displayPrice, makePrice, type SocketLike } from './liveMarket'
import type { Book } from './marketData'

const book = (bids: [number, number][], asks: [number, number][], lastTrade: number | null = null): Book => ({
  bids: bids.map(([price, size]) => ({ price, size })),
  asks: asks.map(([price, size]) => ({ price, size })),
  lastTrade,
})

describe('applyPriceChanges', () => {
  const base = book([[0.5, 100], [0.48, 50]], [[0.52, 80], [0.55, 10]], 0.51)

  it('replaces the size at an existing level', () => {
    const next = applyPriceChanges(base, [{ side: 'BUY', price: 0.48, size: 75 }])
    expect(next.bids).toEqual([{ price: 0.5, size: 100 }, { price: 0.48, size: 75 }])
    expect(next.asks).toBe(base.asks)
    expect(base.bids[1].size).toBe(50) // not mutated
  })

  it('removes a level when the size is zero', () => {
    const next = applyPriceChanges(base, [{ side: 'SELL', price: 0.52, size: 0 }])
    expect(next.asks).toEqual([{ price: 0.55, size: 10 }])
  })

  it('inserts new levels in best-first order on both sides', () => {
    const next = applyPriceChanges(base, [
      { side: 'BUY', price: 0.51, size: 5 },
      { side: 'BUY', price: 0.4, size: 7 },
      { side: 'BUY', price: 0.49, size: 9 },
      { side: 'SELL', price: 0.515, size: 3 },
      { side: 'SELL', price: 0.6, size: 4 },
    ])
    expect(next.bids.map((l) => l.price)).toEqual([0.51, 0.5, 0.49, 0.48, 0.4])
    expect(next.asks.map((l) => l.price)).toEqual([0.515, 0.52, 0.55, 0.6])
    expect(next.lastTrade).toBe(0.51)
  })

  it('returns the same book when nothing changes', () => {
    expect(applyPriceChanges(base, [])).toBe(base)
    expect(applyPriceChanges(base, [{ side: 'BUY', price: 0.5, size: 100 }])).toBe(base)
    expect(applyPriceChanges(base, [{ side: 'SELL', price: 0.9, size: 0 }])).toBe(base)
    expect(applyPriceChanges(base, [{ side: 'SELL', price: NaN, size: 3 }])).toBe(base)
  })

  it('matches prices written with different decimals', () => {
    const next = applyPriceChanges(base, [{ side: 'BUY', price: Number('0.50'), size: 1 }])
    expect(next.bids[0]).toEqual({ price: 0.5, size: 1 })
    expect(next.bids).toHaveLength(2)
  })
})

describe('displayPrice', () => {
  it('uses the midpoint while the spread is at most 10¢', () => {
    expect(displayPrice(makePrice(0.4, 0.5, 0.9))).toBeCloseTo(0.45)
    expect(displayPrice(makePrice(0.62, 0.63, null))).toBeCloseTo(0.625)
  })
  it('falls back to the last trade on a wide or one-sided book', () => {
    expect(displayPrice(makePrice(0.2, 0.5, 0.33))).toBe(0.33)
    expect(displayPrice(makePrice(null, 0.5, 0.41))).toBe(0.41)
    expect(displayPrice(makePrice(null, null, null))).toBeNull()
    expect(displayPrice(undefined)).toBeNull()
  })
})

// ---------- connection manager ----------

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  /** Answer PING like the server does. */
  pong = true
  send(data: string) {
    this.sent.push(data)
    if (data === 'PING' && this.pong) this.receive('PONG')
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.({})
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) })
  }
  drop() {
    this.onclose?.({})
  }
  json() {
    return this.sent.filter((s) => s !== 'PING').map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

function setup(extra: Parameters<typeof createLiveMarket>[0] = {}) {
  const sockets: FakeSocket[] = []
  const live = createLiveMarket({
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    random: () => 0,
    env: null,
    ...extra,
  })
  return { live, sockets, last: () => sockets[sockets.length - 1] }
}

const bookMsg = (asset_id: string, bids: [string, string][], asks: [string, string][]) => ({
  event_type: 'book',
  asset_id,
  bids: bids.map(([price, size]) => ({ price, size })),
  asks: asks.map(([price, size]) => ({ price, size })),
  last_trade_price: '0.5',
  timestamp: '1791290905007',
  hash: 'h',
})

describe('createLiveMarket', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens one socket for all subscribers and sends the union of assets', () => {
    const { live, sockets, last } = setup()
    live.subscribe(['a', 'b'])
    live.subscribe(['b', 'c'])
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(1)
    expect(live.getStatus()).toBe('connecting')
    last().open()
    expect(live.getStatus()).toBe('live')
    expect(last().json()).toEqual([{ assets_ids: ['a', 'b', 'c'], type: 'market' }])
  })

  it('changes the subscription in place as components come and go', () => {
    const { live, last } = setup()
    const offA = live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    last().open()
    const offB = live.subscribe(['a', 'b'])
    vi.advanceTimersByTime(1)
    offA()
    vi.advanceTimersByTime(1)
    expect(last().json().slice(1)).toEqual([{ assets_ids: ['b'], operation: 'subscribe' }]) // 'a' still held by the second
    offB()
    vi.advanceTimersByTime(1)
    expect(last().json().slice(2)).toEqual([{ assets_ids: ['a', 'b'], operation: 'unsubscribe' }])
  })

  it('coalesces an unmount followed by a remount (StrictMode) into nothing', () => {
    const { live, last } = setup()
    live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    last().open()
    const off = live.subscribe(['b'])
    off()
    live.subscribe(['b'])
    vi.advanceTimersByTime(1)
    expect(last().json().slice(1)).toEqual([{ assets_ids: ['b'], operation: 'subscribe' }])
  })

  it('keeps books from snapshots and deltas and batches listener updates', () => {
    const { live, last } = setup({ throttleMs: 250 })
    const onUpdate = vi.fn()
    live.subscribe(['a'], { onUpdate })
    vi.advanceTimersByTime(1)
    last().open()
    last().receive([bookMsg('a', [['0.48', '10'], ['0.5', '20']], [['0.53', '5'], ['0.52', '7']]), bookMsg('zz', [], [])])
    for (let i = 1; i <= 20; i++) {
      last().receive({
        event_type: 'price_change',
        market: '0x1',
        price_changes: [
          { asset_id: 'a', price: '0.51', size: String(i), side: 'BUY', best_bid: '0.51', best_ask: '0.52' },
          { asset_id: 'other', price: '0.49', size: '1', side: 'SELL', best_bid: '0.48', best_ask: '0.49' },
        ],
      })
    }
    expect(onUpdate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(['a'])
    expect(live.getBook('a')?.bids).toEqual([{ price: 0.51, size: 20 }, { price: 0.5, size: 20 }, { price: 0.48, size: 10 }])
    expect(live.getBook('a')?.asks[0]).toEqual({ price: 0.52, size: 7 })
    expect(live.getBook('zz')).toBeUndefined() // never subscribed
    expect(live.getBook('other')).toBeUndefined()
    // The book's last_trade_price is market-wide (same on both tokens), so it is not taken as this token's last.
    expect(live.getPrice('a')).toMatchObject({ bid: 0.51, ask: 0.52, last: null })
    expect(live.getBook('a')?.lastTrade).toBeNull()
    expect(live.getPrice('a')?.mid).toBeCloseTo(0.515)
  })

  it('delivers trades and updates the last price', () => {
    const { live, last } = setup({ throttleMs: 100 })
    const onTrades = vi.fn()
    live.subscribe(['a', 'b'], { onTrades })
    vi.advanceTimersByTime(1)
    last().open()
    last().receive({ event_type: 'last_trade_price', asset_id: 'a', price: '0.66', size: '4.5', side: 'SELL', timestamp: '1791290928222', transaction_hash: '0xabc' })
    last().receive({ event_type: 'last_trade_price', asset_id: 'b', price: '0.34', size: '2', side: 'BUY', timestamp: '1791290929000' })
    vi.advanceTimersByTime(100)
    expect(onTrades).toHaveBeenCalledTimes(1)
    expect(onTrades.mock.calls[0][0]).toEqual([
      { assetId: 'a', side: 'SELL', price: 0.66, size: 4.5, timestamp: 1791290928.222, tx: '0xabc' },
      { assetId: 'b', side: 'BUY', price: 0.34, size: 2, timestamp: 1791290929, tx: undefined },
    ])
    expect(live.getPrice('a')?.last).toBe(0.66)
    last().receive(bookMsg('a', [['0.6', '1']], [['0.7', '1']])) // carries the market-wide 0.5
    expect(live.getPrice('a')?.last).toBe(0.66)
    expect(live.getBook('a')?.lastTrade).toBe(0.66)
  })

  it('ignores PONG and non-JSON replies', () => {
    const { live, last } = setup()
    live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    last().open()
    expect(() => {
      last().receive('PONG')
      last().receive('INVALID OPERATION')
    }).not.toThrow()
  })

  it('pings to keep alive and reconnects when the socket goes quiet', () => {
    const { live, sockets, last } = setup({ pingMs: 10_000, staleMs: 30_000 })
    live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    last().open()
    vi.advanceTimersByTime(60_000)
    expect(last().sent.filter((s) => s === 'PING')).toHaveLength(6)
    expect(sockets).toHaveLength(1) // PONGs keep it alive
    last().pong = false
    vi.advanceTimersByTime(40_000) // no reply for 30 s+
    expect(sockets[0].closed).toBe(true)
    expect(live.getStatus()).toBe('offline')
    vi.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(2)
  })

  it('reconnects with growing backoff, drops stale books and resubscribes everything', () => {
    const { live, sockets, last } = setup({ random: () => 1 })
    const onUpdate = vi.fn()
    live.subscribe(['a', 'b'], { onUpdate })
    vi.advanceTimersByTime(1)
    last().open()
    last().receive(bookMsg('a', [['0.4', '1']], []))
    last().drop()
    expect(live.getStatus()).toBe('offline')
    expect(live.getBook('a')).toBeUndefined()
    vi.advanceTimersByTime(250)
    expect(onUpdate).toHaveBeenLastCalledWith(['a']) // hooks learn the book is gone
    vi.advanceTimersByTime(999 - 250)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    last().drop() // failed before opening: next wait doubles
    vi.advanceTimersByTime(1_999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
    last().open()
    expect(last().json()).toEqual([{ assets_ids: ['a', 'b'], type: 'market' }])
    expect(live.getStatus()).toBe('live')
  })

  it('keeps backing off when the server answers with an error and closes', () => {
    const { live, sockets, last } = setup({ random: () => 1 })
    live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    const waits: number[] = []
    for (let i = 0; i < 4; i++) {
      const before = sockets.length
      last().open()
      last().receive('INVALID OPERATION')
      last().receive('PONG')
      last().drop()
      let t = 0
      while (sockets.length === before) {
        vi.advanceTimersByTime(50)
        t += 50
      }
      waits.push(t)
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000])
  })

  it('resets the backoff once market data arrives', () => {
    const { live, sockets, last } = setup({ random: () => 1 })
    live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    last().drop()
    vi.advanceTimersByTime(1000)
    last().drop()
    vi.advanceTimersByTime(2000)
    expect(sockets).toHaveLength(3)
    last().open()
    last().receive(bookMsg('a', [['0.4', '1']], []))
    last().drop()
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(4)
  })

  it('backoff is jittered and capped', () => {
    const { live, sockets, last } = setup({ random: () => 0.5, maxBackoffMs: 4_000 })
    live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    const waits: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = sockets.length
      last().drop()
      let t = 0
      while (sockets.length === before) {
        vi.advanceTimersByTime(50)
        t += 50
      }
      waits.push(t)
    }
    expect(waits).toEqual([750, 1500, 3000, 3000, 3000])
  })

  it('closes after the last subscriber leaves, but not on quick navigation', () => {
    const { live, sockets, last } = setup({ idleCloseMs: 5_000 })
    const off = live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    last().open()
    off()
    vi.advanceTimersByTime(2_000)
    live.subscribe(['b'])
    vi.advanceTimersByTime(10_000)
    expect(sockets).toHaveLength(1)
    expect(sockets[0].closed).toBe(false)
    expect(last().json().slice(1)).toEqual([{ assets_ids: ['a'], operation: 'unsubscribe' }, { assets_ids: ['b'], operation: 'subscribe' }])
  })

  it('closes when idle and reports offline', () => {
    const { live, sockets, last } = setup({ idleCloseMs: 5_000 })
    const off = live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    last().open()
    off()
    vi.advanceTimersByTime(5_001)
    expect(sockets[0].closed).toBe(true)
    expect(live.getStatus()).toBe('offline')
  })

  it('pauses while the tab is hidden and resumes when it is visible', () => {
    let visible = true
    let onVis = () => {}
    const { live, sockets, last } = setup({
      hiddenCloseMs: 60_000,
      env: {
        visible: () => visible,
        listen: (v) => {
          onVis = v
        },
      },
    })
    const statuses: string[] = []
    live.onStatus(() => statuses.push(live.getStatus()))
    live.subscribe(['a'])
    vi.advanceTimersByTime(1)
    last().open()
    visible = false
    onVis()
    vi.advanceTimersByTime(30_000)
    visible = true
    onVis() // back quickly: stays open
    expect(sockets[0].closed).toBe(false)
    visible = false
    onVis()
    vi.advanceTimersByTime(60_000)
    expect(sockets[0].closed).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(sockets).toHaveLength(1) // no reconnect attempts while hidden
    visible = true
    onVis()
    expect(sockets).toHaveLength(2)
    last().open()
    expect(statuses).toEqual(['connecting', 'live', 'offline', 'connecting', 'live'])
  })

})
