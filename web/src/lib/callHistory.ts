import { DATA_API } from '../config'

// Closed calls (sold or resolved positions) with realized P&L, from Data API v2 positions?status=CLOSED.

export type CallResult = 'won' | 'lost' | 'sold'

export type ClosedCall = {
  asset: string
  conditionId: string
  title: string
  outcome: string
  eventSlug?: string
  icon?: string
  shares: number
  avgPrice: number
  /** What the call cost, including entry fees. */
  cost: number
  realizedPnl: number
  /** Realized return on cost, as a fraction (0.25 = +25%); null when the cost is unknown. */
  ret: number | null
  result: CallResult
  closedAt: number
  openedAt: number
}

type V2Closed = {
  token_id: string
  condition_id: string
  title: string
  outcome: string
  event_slug?: string
  icon?: string
  total_size: number
  avg_price: number
  total_cost_usdc: number
  entry_fees_usdc?: number
  current_price: number
  realized_pnl: number
  percent_realized_pnl?: number
  last_event_at: number
  first_entry_at: number
}

/**
 * A market that settled at 0 or 1 resolved; the call "won" or "lost" by its realized P&L there.
 * Anything else was closed by selling before the market resolved.
 */
export function callResult(price: number, realizedPnl: number): CallResult {
  const resolved = price >= 0.99 || price <= 0.01
  if (!resolved) return 'sold'
  return realizedPnl > 0 ? 'won' : 'lost'
}

export function toClosedCall(p: V2Closed): ClosedCall {
  // total_cost_usdc sometimes holds only the fees, so rebuild the stake from shares × average price.
  const cost = p.total_size * p.avg_price + (p.entry_fees_usdc ?? 0)
  return {
    asset: p.token_id,
    conditionId: p.condition_id,
    title: p.title,
    outcome: p.outcome,
    eventSlug: p.event_slug || undefined,
    icon: p.icon || undefined,
    shares: p.total_size,
    avgPrice: p.avg_price,
    cost,
    realizedPnl: p.realized_pnl,
    ret: cost > 0.0001 ? p.realized_pnl / cost : typeof p.percent_realized_pnl === 'number' ? p.percent_realized_pnl / 100 : null,
    result: callResult(p.current_price, p.realized_pnl),
    closedAt: p.last_event_at,
    openedAt: p.first_entry_at,
  }
}

export type HistoryPage = { calls: ClosedCall[]; next?: string }

/** Most recently closed first; pass `cursor` from the previous page to load older calls. */
export async function fetchCallHistory(wallet: string, cursor?: string, limit = 100): Promise<HistoryPage> {
  const params = new URLSearchParams({ user: wallet, status: 'CLOSED', sort_by: 'TIMESTAMP', limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const res = await fetch(`${DATA_API}/v2/positions?${params}`)
  if (!res.ok) throw new Error(`Call history unavailable: ${res.status}`)
  const body = (await res.json()) as { data?: V2Closed[] | null; pagination?: { has_more?: boolean; next_cursor?: string } }
  return {
    calls: (body.data ?? []).filter((p) => p.total_size >= 0.01).map(toClosedCall),
    next: body.pagination?.has_more ? body.pagination.next_cursor : undefined,
  }
}

export type HistorySummary = {
  count: number
  realized: number
  wins: number
  losses: number
  /** Share of calls closed in profit, 0–1; null with no calls. */
  winRate: number | null
  best: ClosedCall | null
  worst: ClosedCall | null
  invested: number
}

export function summarize(calls: ClosedCall[]): HistorySummary {
  let realized = 0
  let invested = 0
  let wins = 0
  let losses = 0
  let best: ClosedCall | null = null
  let worst: ClosedCall | null = null
  for (const c of calls) {
    realized += c.realizedPnl
    invested += c.cost
    if (c.realizedPnl > 0.005) wins++
    else if (c.realizedPnl < -0.005) losses++
    if (!best || c.realizedPnl > best.realizedPnl) best = c
    if (!worst || c.realizedPnl < worst.realizedPnl) worst = c
  }
  const decided = wins + losses
  return {
    count: calls.length,
    realized,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : null,
    best: best && best.realizedPnl > 0 ? best : null,
    worst: worst && worst.realizedPnl < 0 ? worst : null,
    invested,
  }
}

/** Running realized P&L in time order, for the sparkline: [{ t, pnl }]. */
export function cumulative(calls: ClosedCall[]): { t: number; pnl: number }[] {
  let sum = 0
  return [...calls]
    .sort((a, b) => a.closedAt - b.closedAt)
    .map((c) => {
      sum += c.realizedPnl
      return { t: c.closedAt, pnl: sum }
    })
}
