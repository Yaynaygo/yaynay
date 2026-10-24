import { DATA_API, PNL_API } from '../config'
import type { ActivityItem } from './activity'

// ---------- profit and loss over time ----------

export type PnlRange = '1D' | '1W' | '1M' | 'ALL'
export const PNL_RANGES: PnlRange[] = ['1D', '1W', '1M', 'ALL']

/** One sample of all-time profit and loss (USD) at unix time `t`. */
export type PnlPoint = { t: number; p: number }

const PNL_QUERY: Record<PnlRange, string> = {
  '1D': 'interval=1d&fidelity=1h',
  '1W': 'interval=1w&fidelity=1h',
  '1M': 'interval=1m&fidelity=1d',
  ALL: 'interval=all&fidelity=1d',
}

/** All-time P&L samples for a Polymarket wallet over `range`, oldest first (the series polymarket.com charts). */
export async function fetchPnlSeries(wallet: string, range: PnlRange): Promise<PnlPoint[]> {
  const url = `${PNL_API}/user-pnl?user_address=${wallet}&${PNL_QUERY[range]}`
  // The P&L service fails now and then; one quiet retry hides most blips.
  const res = await fetch(url).then(
    (r) => (r.ok ? r : new Promise<Response>((ok) => setTimeout(() => ok(fetch(url)), 1200))),
    () => new Promise<Response>((ok) => setTimeout(() => ok(fetch(url)), 1200)),
  )
  if (!res.ok) throw new Error(`P&L unavailable: ${res.status}`)
  const body = (await res.json()) as unknown
  if (!Array.isArray(body)) return []
  return body
    .filter((x): x is PnlPoint => typeof x?.t === 'number' && typeof x?.p === 'number' && Number.isFinite(x.p))
    .sort((a, b) => a.t - b.t)
}

const SPAN: Record<PnlRange, number | null> = { '1D': 86_400, '1W': 7 * 86_400, '1M': 30 * 86_400, ALL: null }
const STEP: Record<PnlRange, number> = { '1D': 3600, '1W': 3600, '1M': 86_400, ALL: 86_400 }

/**
 * Adds a break-even point before the first sample when the series starts after the window opened, which
 * means the account had no P&L yet (a new account, or "ALL"). Polymarket's own chart starts from zero the
 * same way; without it a new account's "past week" would be measured from its first loss, not from $0.
 */
export function withBaseline(points: PnlPoint[], range: PnlRange, now = Math.floor(Date.now() / 1000)): PnlPoint[] {
  if (points.length === 0) return points
  const first = points[0]
  const span = SPAN[range]
  const startsLate = span === null || first.t > now - span + STEP[range] * 1.5
  if (!startsLate || Math.abs(first.p) < 1e-9) return points
  return [{ t: first.t - STEP[range], p: 0 }, ...points]
}

/**
 * Profit or loss made inside the window. "ALL" starts from zero, so it is the all-time figure;
 * shorter windows measure from their first sample.
 */
export function periodChange(points: PnlPoint[], range: PnlRange): number {
  if (points.length === 0) return 0
  const last = points[points.length - 1].p
  return range === 'ALL' ? last : last - points[0].p
}

/** A series a chart can draw: at least two points, and a flat line now → now when there is only one. */
export function drawable(points: PnlPoint[], now = Math.floor(Date.now() / 1000)): PnlPoint[] {
  if (points.length >= 2) return points
  const p = points[0]?.p ?? 0
  const t = points[0]?.t ?? now
  return [
    { t: Math.min(t, now) - 3600, p },
    { t: Math.max(t, now), p },
  ]
}

/** Number of distinct markets a wallet has traded (Data API v2 user-stats; unknown wallets count 0). */
export async function fetchMarketsTraded(wallet: string): Promise<number> {
  const res = await fetch(`${DATA_API}/v2/user-stats?user=${wallet}`)
  if (!res.ok) throw new Error(`User stats unavailable: ${res.status}`)
  const body = (await res.json()) as { data?: { trades?: number } | null }
  return body.data?.trades ?? 0
}

/** Current value of a wallet's open positions (Data API v2). */
export async function fetchPositionsValue(wallet: string): Promise<number> {
  const res = await fetch(`${DATA_API}/v2/value?user=${wallet}`)
  if (!res.ok) throw new Error(`Value unavailable: ${res.status}`)
  const body = (await res.json()) as { data?: { value?: number } | null }
  return body.data?.value ?? 0
}

// ---------- calling card ----------

export type Lean = 'yay' | 'nay' | 'pick'

/** Yes/Up/Over read as a "yay" call, No/Down/Under as "nay"; named outcomes (teams, candidates) are picks. */
export function leanOf(outcome?: string): Lean {
  const o = (outcome ?? '').trim().toLowerCase()
  if (o === 'yes' || o === 'up' || o === 'over') return 'yay'
  if (o === 'no' || o === 'down' || o === 'under') return 'nay'
  return 'pick'
}

export type CallerStyle = { id: 'underdog' | 'balanced' | 'favorite'; label: string; blurb: string }

const STYLES: Record<CallerStyle['id'], Omit<CallerStyle, 'id'>> = {
  underdog: { label: 'Underdog hunter', blurb: 'You buy long shots, where a small stake pays a lot.' },
  balanced: { label: 'Coin-flip caller', blurb: 'You trade close calls, where the crowd is split.' },
  favorite: { label: 'Favorite backer', blurb: 'You back the likely side and collect smaller wins.' },
}

/** Style from the stake-weighted average entry price of buys. */
export function callerStyle(avgEntry: number | null): CallerStyle | null {
  if (avgEntry === null) return null
  const id = avgEntry < 0.38 ? 'underdog' : avgEntry > 0.68 ? 'favorite' : 'balanced'
  return { id, ...STYLES[id] }
}

export type CallingCard = {
  trades: number
  /** USD bought plus USD sold. */
  volume: number
  /** Share of USD bought on each kind of outcome, summing to 1 (all 0 with no buys). */
  lean: Record<Lean, number>
  /** Stake-weighted average buy price (0–1), or null with no priced buys. */
  avgEntry: number | null
  style: CallerStyle | null
  /** Days with at least one trade, counting back from the latest trade day without a gap. */
  streak: number
}

const dayIndex = (ts: number) => {
  const d = new Date(ts * 1000)
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
}

/** Trading profile from a list of activity items (only trades count). */
export function callingCard(items: ActivityItem[], now = Date.now() / 1000): CallingCard {
  const trades = items.filter((a) => a.kind === 'BUY' || a.kind === 'SELL')
  const buys = trades.filter((a) => a.kind === 'BUY')
  const volume = trades.reduce((s, a) => s + a.usd, 0)

  const bought = { yay: 0, nay: 0, pick: 0 }
  let priced = 0
  let weighted = 0
  for (const b of buys) {
    bought[leanOf(b.outcome)] += b.usd
    if (typeof b.price === 'number' && b.price > 0 && b.price < 1 && b.usd > 0) {
      priced += b.usd
      weighted += b.price * b.usd
    }
  }
  const total = bought.yay + bought.nay + bought.pick
  const lean = total > 0 ? { yay: bought.yay / total, nay: bought.nay / total, pick: bought.pick / total } : { yay: 0, nay: 0, pick: 0 }
  const avgEntry = priced > 0 ? weighted / priced : null

  // A streak is alive if the latest trade was today or yesterday.
  const days = new Set(trades.map((a) => dayIndex(a.timestamp)))
  let streak = 0
  const today = dayIndex(now)
  let d = days.has(today) ? today : days.has(today - 1) ? today - 1 : null
  while (d !== null && days.has(d)) {
    streak++
    d--
  }

  return { trades: trades.length, volume, lean, avgEntry, style: callerStyle(avgEntry), streak }
}

// ---------- activity grouping ----------

/** Top-ups into Arc are recorded locally as OTHER with a `topup-` id. */
export const isTopUp = (a: ActivityItem) => a.kind === 'OTHER' && a.id.startsWith('topup-')

export type ActivityFilter = 'all' | 'trades' | 'claims' | 'transfers'

export function matchesFilter(a: ActivityItem, f: ActivityFilter): boolean {
  if (f === 'trades') return a.kind === 'BUY' || a.kind === 'SELL'
  if (f === 'claims') return a.kind === 'REDEEM'
  if (f === 'transfers') return a.kind === 'DEPOSIT' || a.kind === 'WITHDRAW' || isTopUp(a)
  return true
}

// Sign from the point of view of the trading balance: money in is +, money out is −.
export const FLOW: Record<ActivityItem['kind'], 1 | -1 | 0> = { BUY: -1, SELL: 1, REDEEM: 1, DEPOSIT: 1, WITHDRAW: -1, OTHER: 0 }

/** Net cash flow into the trading balance across a set of items. */
export function netFlow(items: ActivityItem[]): number {
  return items.reduce((s, a) => s + FLOW[a.kind] * a.usd, 0)
}

/** Seconds → "just now", "5m ago", "3h ago", "2d ago", else a short date. */
export function timeAgo(ts: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - ts)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d ago`
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Compact USD: $950, $12.4k, $3.1M. */
export function compactUsd(n: number): string {
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}k`
  return `${sign}$${a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
