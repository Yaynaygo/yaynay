import { CLOB_API, DATA_API, DECIDED_PRICE, RECURRING_ROUND_RE } from '../config'

export type PricePoint = { t: number; p: number }

/** Price history of one outcome token from the public CLOB endpoint. */
export async function fetchPriceHistory(tokenId: string, interval: '1d' | '1w' | '1m' = '1w'): Promise<PricePoint[]> {
  const fidelity = interval === '1d' ? 15 : interval === '1w' ? 120 : 480
  const res = await fetch(`${CLOB_API}/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`)
  if (!res.ok) throw new Error(`Price history unavailable: ${res.status}`)
  const body = (await res.json()) as { history?: PricePoint[] }
  return body.history ?? []
}

export type TapeTrade = {
  side: 'BUY' | 'SELL'
  outcome: string
  /** 0 = the first outcome (Yes, Up, the first team), 1 = the second. */
  outcomeIndex: number
  title: string
  icon?: string
  eventSlug?: string
  usd: number
  price: number
  timestamp: number
}

/** Recent Polymarket trades (Data API v2) for the live tape; tiny and recurring-round fills are skipped. */
export async function fetchRecentTrades(limit = 60): Promise<TapeTrade[]> {
  const res = await fetch(`${DATA_API}/v2/trades?limit=${limit}`)
  if (!res.ok) throw new Error(`Trades unavailable: ${res.status}`)
  const body = (await res.json()) as {
    data?: {
      side: 'BUY' | 'SELL'
      outcome: string
      outcome_index?: number
      title: string
      icon?: string
      event_slug?: string
      size: number
      price: number
      timestamp: number
    }[]
  }
  return (body.data ?? [])
    .map((t) => ({
      side: t.side,
      outcome: t.outcome,
      outcomeIndex: t.outcome_index ?? 0,
      title: t.title,
      icon: t.icon || undefined,
      eventSlug: t.event_slug || undefined,
      usd: t.size * t.price,
      price: t.price,
      timestamp: t.timestamp,
    }))
    .filter((t) => t.usd >= 5 && t.price > 1 - DECIDED_PRICE && t.price < DECIDED_PRICE && !RECURRING_ROUND_RE.test(t.title))
}

/**
 * Busy markets fill the raw feed with fills of the same call. Merge fills on the same market, outcome and
 * side (summing the money), then keep at most two calls per event so the tape shows many markets.
 */
export function diversify(trades: TapeTrade[], perEvent = 2): TapeTrade[] {
  const merged = new Map<string, TapeTrade>()
  for (const t of trades) {
    const key = `${t.title}|${t.outcome}|${t.side}`
    const m = merged.get(key)
    if (m) {
      m.usd += t.usd
      m.timestamp = Math.max(m.timestamp, t.timestamp)
    } else merged.set(key, { ...t })
  }
  const seen = new Map<string, number>()
  const out: TapeTrade[] = []
  for (const t of merged.values()) {
    const event = t.eventSlug ?? t.title
    const n = seen.get(event) ?? 0
    if (n >= perEvent) continue
    seen.set(event, n + 1)
    out.push(t)
  }
  return out
}
