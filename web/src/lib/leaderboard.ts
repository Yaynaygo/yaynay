import { DATA_API } from '../config'
import { publicName } from './smartMoney'

export type LeaderPeriod = 'day' | 'week' | 'month' | 'all'
export type LeaderSort = 'PNL' | 'VOLUME'

export const LEADER_PERIODS: { id: LeaderPeriod; label: string }[] = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All time' },
]

export const LEADER_CATEGORIES: { id: string; label: string }[] = [
  { id: 'overall', label: 'All' },
  { id: 'politics', label: 'Politics' },
  { id: 'sports', label: 'Sports' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'economics', label: 'Economy' },
  { id: 'finance', label: 'Finance' },
  { id: 'tech', label: 'Tech' },
  { id: 'culture', label: 'Culture' },
  { id: 'weather', label: 'Weather' },
]

export type Leader = {
  rank: number
  wallet: string
  name: string
  /** X handle without the @, when the trader linked one. */
  x?: string
  verified: boolean
  pnl: number
  volume: number
}

export type LeaderPage = { rows: Leader[]; next?: string }

type V2Row = {
  rank: number
  user_id: string
  pnl: number
  volume: number
  user_name?: string
  x_username?: string
  verified?: boolean
}

export function toLeader(r: V2Row): Leader {
  return {
    rank: Number(r.rank),
    wallet: r.user_id.toLowerCase(),
    name: publicName(r.user_id, r.user_name),
    x: r.x_username?.replace(/^@/, '') || undefined,
    verified: !!r.verified,
    pnl: Number(r.pnl) || 0,
    volume: Number(r.volume) || 0,
  }
}

/** One page of Polymarket's trader leaderboard (Data API v2, cursor-paged). */
export async function fetchLeaders(
  q: { period: LeaderPeriod; sort: LeaderSort; category: string },
  cursor?: string,
  limit = 50,
): Promise<LeaderPage> {
  const params = new URLSearchParams({ time_period: q.period, sort_by: q.sort, limit: String(limit) })
  if (q.category !== 'overall') params.set('category', q.category)
  if (cursor) params.set('cursor', cursor)
  const res = await fetch(`${DATA_API}/v2/leaderboard?${params}`)
  if (!res.ok) throw new Error(`Leaderboard unavailable: ${res.status}`)
  const body = (await res.json()) as { data?: V2Row[] | null; pagination?: { has_more?: boolean; next_cursor?: string } }
  if (!Array.isArray(body.data)) throw new Error('Leaderboard response changed')
  return {
    rows: body.data.map(toLeader),
    next: body.pagination?.has_more ? body.pagination.next_cursor || undefined : undefined,
  }
}

export type MyRank = { pnl: number; volume: number; rankPnl: number | null; rankVolume: number | null }

/** A single wallet's standing on the overall board for a period. */
export async function fetchMyRank(wallet: string, period: LeaderPeriod): Promise<MyRank | null> {
  const params = new URLSearchParams({ time_period: period, sort_by: 'PNL', user: wallet })
  const res = await fetch(`${DATA_API}/v2/leaderboard?${params}`)
  if (!res.ok) return null
  const body = (await res.json()) as { data?: { pnl?: number; volume?: number; rank_pnl?: number; rank_volume?: number } | null }
  const d = body.data
  if (!d || Array.isArray(d)) return null
  return {
    pnl: Number(d.pnl) || 0,
    volume: Number(d.volume) || 0,
    rankPnl: typeof d.rank_pnl === 'number' && d.rank_pnl > 0 ? d.rank_pnl : null,
    rankVolume: typeof d.rank_volume === 'number' && d.rank_volume > 0 ? d.rank_volume : null,
  }
}

/** Share of the leader's figure, 0–1, for the row bars (by P&L or volume). */
export function barShare(row: Leader, top: Leader | undefined, sort: LeaderSort): number {
  const v = sort === 'PNL' ? row.pnl : row.volume
  const max = top ? Math.abs(sort === 'PNL' ? top.pnl : top.volume) : 0
  if (max <= 0) return 0
  return Math.max(0, Math.min(1, Math.abs(v) / max))
}

/** Top-1% style label for a large rank: 1,099,210 → "Top 1.1M". Small ranks print as "#42". */
export function rankLabel(rank: number): string {
  if (rank <= 9999) return `#${rank.toLocaleString()}`
  if (rank < 1e6) return `#${Math.round(rank / 1000)}k`
  return `#${(rank / 1e6).toFixed(1)}M`
}
