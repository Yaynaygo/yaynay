import { CLOB_API, DATA_API } from '../config'
import type { Level } from './quote'

// Public market data for the market page: order book, recent trades and top holders.

export type Book = {
  /** Best (highest) bid first. */
  bids: Level[]
  /** Best (lowest) ask first. */
  asks: Level[]
  lastTrade: number | null
}

export type RawLevel = { price: string; size: string }

/**
 * Normalises a raw CLOB book (REST `/book` or the WebSocket `book` event): sorted best first, empty levels dropped.
 * The book's own `last_trade_price` is ignored: it is one value per market, identical on both tokens, so it is
 * the other side's price about half the time. The per-token last trade comes from `/last-trade-price` or the socket.
 */
export function parseBook(raw: { bids?: RawLevel[]; asks?: RawLevel[] }, lastTrade: number | null = null): Book {
  const levels = (side?: RawLevel[]) =>
    (side ?? []).map((l) => ({ price: Number(l.price), size: Number(l.size) })).filter((l) => l.size > 0)
  return {
    bids: levels(raw.bids).sort((a, b) => b.price - a.price),
    asks: levels(raw.asks).sort((a, b) => a.price - b.price),
    lastTrade,
  }
}

/** Last traded price of one token, or null if it never traded (or the lookup failed). */
export async function fetchLastTrade(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_API}/last-trade-price?token_id=${tokenId}`)
    if (!res.ok) return null
    const p = Number(((await res.json()) as { price?: string }).price)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

export async function fetchBook(tokenId: string): Promise<Book> {
  const [res, last] = await Promise.all([fetch(`${CLOB_API}/book?token_id=${tokenId}`), fetchLastTrade(tokenId)])
  if (!res.ok) throw new Error(`Order book unavailable: ${res.status}`)
  return parseBook((await res.json()) as Parameters<typeof parseBook>[0], last)
}

export type DepthRow = Level & { total: number; cumulative: number }

/** The best `count` levels of one side with running totals, for depth bars. */
export function depth(levels: Level[], count: number): DepthRow[] {
  let cumulative = 0
  return levels.slice(0, count).map((l) => {
    cumulative += l.size
    return { ...l, total: l.price * l.size, cumulative }
  })
}

export type MarketTrade = {
  side: 'BUY' | 'SELL'
  outcome: string
  outcomeIndex: number
  size: number
  price: number
  who: string
  timestamp: number
  tx?: string
}

/** Short public name for a trader: their pseudonym, never the wallet. */
function displayName(pseudonym?: string, name?: string) {
  const n = pseudonym || (name && !name.startsWith('0x') ? name : '')
  return n ? n.replace(/-/g, ' ') : 'Anonymous'
}

export async function fetchMarketTrades(conditionId: string, limit = 25): Promise<MarketTrade[]> {
  // The endpoint is CDN-cached for 5 minutes (max-age=300), which would freeze the tape; a 5-second bucket
  // keeps it fresh while viewers of the same market still share cache entries.
  const bucket = Math.floor(Date.now() / 5_000)
  const res = await fetch(`${DATA_API}/v2/trades?condition=${conditionId}&limit=${limit}&_=${bucket}`)
  if (!res.ok) throw new Error(`Trades unavailable: ${res.status}`)
  const body = (await res.json()) as {
    data?: {
      side: 'BUY' | 'SELL'
      outcome: string
      outcome_index: number
      size: number
      price: number
      pseudonym?: string
      name?: string
      timestamp: number
      transaction_hash?: string
    }[]
  }
  return (body.data ?? []).map((t) => ({
    side: t.side,
    outcome: t.outcome,
    outcomeIndex: t.outcome_index,
    size: t.size,
    price: t.price,
    who: displayName(t.pseudonym, t.name),
    timestamp: t.timestamp,
    tx: t.transaction_hash,
  }))
}

export type Holder = { who: string; amount: number; outcomeIndex: number }

/** Largest holders of each outcome, keyed by outcome index. */
export async function fetchHolders(conditionId: string, limit = 8): Promise<Record<number, Holder[]>> {
  const res = await fetch(`${DATA_API}/v2/holders?condition=${conditionId}&limit=${limit}`)
  if (!res.ok) throw new Error(`Holders unavailable: ${res.status}`)
  const body = (await res.json()) as {
    data?: { holders?: { pseudonym?: string; name?: string; amount: number; outcome_index: number }[] }[]
  }
  const out: Record<number, Holder[]> = {}
  for (const group of body.data ?? []) {
    for (const h of group.holders ?? []) {
      const list = out[h.outcome_index] ?? (out[h.outcome_index] = [])
      list.push({ who: displayName(h.pseudonym, h.name), amount: h.amount, outcomeIndex: h.outcome_index })
    }
  }
  for (const k of Object.keys(out)) out[Number(k)].sort((a, b) => b.amount - a.amount)
  return out
}

/** "12s", "4m", "3h", "2d" ago. */
export function ago(timestamp: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - timestamp))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
