import { CLOB_API, DATA_API } from '../config'

// "Smart money": where Polymarket's most profitable traders stand on a market.
// The smart set is the top TOP_N wallets by PnL on the all-time and the monthly leaderboards.
// For a market we intersect it with the largest holders of each outcome (Data API) and value
// their positions at the current midpoint. Past performance only; never advice.

/** Traders taken from each leaderboard (all-time and this month). */
export const TOP_N = 200
/** Holders fetched per outcome. Smart wallets with smaller positions than the 500th holder are missed. */
export const HOLDERS_LIMIT = 500
/** Positions worth less than this (USD at the midpoint) are dust and ignored. */
export const MIN_VALUE = 5

const CACHE_MS = 30 * 60_000
const STORAGE_KEY = 'yaynay.smartMoney.v1'

export type Period = 'all' | 'month'

export type LeaderRow = { wallet: string; name: string; rank: number; pnl: number }

export type Trader = {
  /** Lowercased proxy wallet; used for matching only, never shown in full. */
  wallet: string
  name: string
  rankAll?: number
  pnlAll?: number
  rankMonth?: number
  pnlMonth?: number
}

export type RawHolder = { wallet: string; outcomeIndex: number; shares: number; pseudonym?: string; name?: string }

export type SmartHolder = {
  wallet: string
  name: string
  trader: Trader
  /** The outcome this trader is net long, by position value. */
  outcomeIndex: number
  shares: number
  /** Net value toward `outcomeIndex`: value held there minus value held on the other outcomes. */
  value: number
  /** True when the trader also holds another outcome of the same market. */
  hedged: boolean
}

export type SideSummary = { outcomeIndex: number; name: string; traders: number; shares: number; value: number }

export type SmartSummary = {
  sides: SideSummary[]
  /** Sorted by net value, largest first. */
  holders: SmartHolder[]
  totalValue: number
  /** Value-weighted share of the leading outcome; null when no smart money holds the market. */
  lean: { outcomeIndex: number; name: string; pct: number } | null
}

const isAddressLike = (s: string) => /^0x[0-9a-f]{6,}/i.test(s)

/** "0x2c33…0563": enough to tell wallets apart, never the full address. */
export function maskWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet
}

/** A public name for a holder: a chosen username, else Polymarket's pseudonym, else a masked wallet. */
export function publicName(wallet: string, ...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    const n = c?.trim()
    if (n && !isAddressLike(n)) return n.replace(/-/g, ' ')
  }
  return maskWallet(wallet)
}

/** Dedupes the two leaderboards by wallet, keeping each trader's rank and PnL on both. */
export function mergeLeaderboards(all: LeaderRow[], month: LeaderRow[]): Trader[] {
  const byWallet = new Map<string, Trader>()
  const add = (rows: LeaderRow[], period: Period) => {
    for (const r of rows) {
      const wallet = r.wallet.toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(wallet) || !Number.isFinite(r.pnl)) continue
      const t = byWallet.get(wallet) ?? { wallet, name: r.name }
      if (!t.name || isAddressLike(t.name)) t.name = r.name
      if (period === 'all' && (t.rankAll === undefined || r.rank < t.rankAll)) {
        t.rankAll = r.rank
        t.pnlAll = r.pnl
      }
      if (period === 'month' && (t.rankMonth === undefined || r.rank < t.rankMonth)) {
        t.rankMonth = r.rank
        t.pnlMonth = r.pnl
      }
      byWallet.set(wallet, t)
    }
  }
  add(all, 'all')
  add(month, 'month')
  return [...byWallet.values()]
}

/** The trader's best standing, for the badge: "#3 all-time" beats "#12 this month" only by rank. */
export function bestRank(t: Trader): { rank: number; period: Period; pnl: number } {
  const all = t.rankAll !== undefined ? { rank: t.rankAll, period: 'all' as const, pnl: t.pnlAll ?? 0 } : null
  const month = t.rankMonth !== undefined ? { rank: t.rankMonth, period: 'month' as const, pnl: t.pnlMonth ?? 0 } : null
  if (all && month) return month.rank < all.rank ? month : all
  return all ?? month ?? { rank: Infinity, period: 'all', pnl: 0 }
}

/**
 * Intersects a market's holders with the smart set. Each trader counts once, on the outcome they
 * are net long by value; a hedged trader contributes only the net difference to the lean.
 */
export function aggregate(
  traders: Trader[],
  holders: RawHolder[],
  prices: number[],
  outcomeNames: string[],
  minValue = MIN_VALUE,
): SmartSummary {
  const smart = new Map(traders.map((t) => [t.wallet, t]))
  // wallet -> outcome index -> shares (summed, so duplicate rows cannot double-count)
  const positions = new Map<string, { raw: RawHolder; shares: Map<number, number> }>()
  for (const h of holders) {
    const wallet = h.wallet.toLowerCase()
    if (!smart.has(wallet) || !(h.shares > 0) || h.outcomeIndex < 0 || h.outcomeIndex >= outcomeNames.length) continue
    const p = positions.get(wallet) ?? { raw: h, shares: new Map<number, number>() }
    // The Data API can list the same holder twice across pages; keep the larger figure, not the sum.
    p.shares.set(h.outcomeIndex, Math.max(p.shares.get(h.outcomeIndex) ?? 0, h.shares))
    positions.set(wallet, p)
  }

  const out: SmartHolder[] = []
  for (const [wallet, { raw, shares }] of positions) {
    const values = [...shares].map(([i, s]) => ({ i, s, v: s * (prices[i] ?? 0) }))
    values.sort((a, b) => b.v - a.v || b.s - a.s)
    const top = values[0]
    const rest = values.slice(1).reduce((sum, x) => sum + x.v, 0)
    const net = top.v - rest
    if (net < minValue) continue
    const trader = smart.get(wallet)!
    out.push({
      wallet,
      name: publicName(wallet, raw.name, trader.name, raw.pseudonym),
      trader,
      outcomeIndex: top.i,
      shares: top.s,
      value: net,
      hedged: values.length > 1,
    })
  }
  out.sort((a, b) => b.value - a.value || bestRank(a.trader).rank - bestRank(b.trader).rank)

  const sides: SideSummary[] = outcomeNames.map((name, outcomeIndex) => ({ outcomeIndex, name, traders: 0, shares: 0, value: 0 }))
  for (const h of out) {
    const s = sides[h.outcomeIndex]
    s.traders += 1
    s.shares += h.shares
    s.value += h.value
  }
  const totalValue = sides.reduce((sum, s) => sum + s.value, 0)
  const lead = [...sides].sort((a, b) => b.value - a.value)[0]
  return {
    sides,
    holders: out,
    totalValue,
    lean: totalValue > 0 && lead ? { outcomeIndex: lead.outcomeIndex, name: lead.name, pct: lead.value / totalValue } : null,
  }
}

/** "Smart money leans Yes 72%", or "is split" when no side has more than 55%. */
export function leanHeadline(summary: SmartSummary): string {
  const { lean } = summary
  if (!lean) return 'No smart money here yet'
  if (lean.pct < 0.55) return 'Smart money is split'
  return `Smart money leans ${lean.name} ${Math.round(lean.pct * 100)}%`
}

// ---------- fetching ----------

type Stored = { at: number; traders: Trader[] }
let memory: Stored | null = null
let inflight: Promise<Trader[]> | null = null

function readStored(): Stored | null {
  if (memory && Date.now() - memory.at < CACHE_MS) return memory
  try {
    const s = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Stored | null
    if (s && Array.isArray(s.traders) && Date.now() - s.at < CACHE_MS) return (memory = s)
  } catch {
    // storage blocked or corrupt: refetch
  }
  return null
}

async function fetchLeaderboardV2(period: Period): Promise<LeaderRow[]> {
  const res = await fetch(`${DATA_API}/v2/leaderboard?time_period=${period}&sort_by=PNL&limit=${TOP_N}`)
  if (!res.ok) throw new Error(`Leaderboard unavailable: ${res.status}`)
  const body = (await res.json()) as { data?: { rank: number; user_id: string; pnl: number; user_name?: string }[] }
  if (!Array.isArray(body.data)) throw new Error('Leaderboard response changed')
  return body.data.map((r) => ({ wallet: r.user_id, name: r.user_name ?? '', rank: Number(r.rank), pnl: Number(r.pnl) }))
}

// Data API v1 was retired on 2026-10-24, so v2 is the only source.
const fetchLeaderboard = fetchLeaderboardV2

/** The smart set, cached for 30 minutes in memory and sessionStorage. */
export function loadSmartSet(): Promise<Trader[]> {
  const cached = readStored()
  if (cached) return Promise.resolve(cached.traders)
  if (!inflight) {
    inflight = Promise.all([fetchLeaderboard('all'), fetchLeaderboard('month')])
      .then(([all, month]) => {
        const traders = mergeLeaderboards(all, month)
        memory = { at: Date.now(), traders }
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory))
        } catch {
          // quota or privacy mode: memory cache still works
        }
        return traders
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

export async function fetchMarketHolders(conditionId: string, limit = HOLDERS_LIMIT): Promise<RawHolder[]> {
  const res = await fetch(`${DATA_API}/v2/holders?condition=${conditionId}&limit=${limit}`)
  if (!res.ok) throw new Error(`Holders unavailable: ${res.status}`)
  const body = (await res.json()) as {
    data?: { holders?: { proxy_wallet: string; pseudonym?: string; name?: string; amount: number; outcome_index: number }[] }[]
  }
  return (body.data ?? []).flatMap((g) =>
    (g.holders ?? []).map((h) => ({
      wallet: h.proxy_wallet,
      outcomeIndex: h.outcome_index,
      shares: Number(h.amount),
      pseudonym: h.pseudonym,
      name: h.name,
    })),
  )
}

/** Current midpoints, in outcome order. A missing book falls back to the complement or 0.5. */
export async function fetchMidpoints(tokenIds: string[]): Promise<number[]> {
  const res = await fetch(`${CLOB_API}/midpoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
  })
  const body = res.ok ? ((await res.json()) as Record<string, string>) : {}
  const mids = tokenIds.map((id) => {
    const n = Number(body[id])
    return Number.isFinite(n) && n > 0 ? n : NaN
  })
  return mids.map((m, i) => {
    if (!Number.isNaN(m)) return m
    const other = mids[1 - i]
    return mids.length === 2 && !Number.isNaN(other) ? 1 - other : 0.5
  })
}

export async function loadSmartMoney(conditionId: string, outcomes: { name: string; tokenId: string }[]): Promise<SmartSummary> {
  const [traders, holders, prices] = await Promise.all([
    loadSmartSet(),
    fetchMarketHolders(conditionId),
    fetchMidpoints(outcomes.map((o) => o.tokenId)),
  ])
  return aggregate(
    traders,
    holders,
    prices,
    outcomes.map((o) => o.name),
  )
}

// ---------- optional Nansen enrichment ----------

export type NansenStats = { winRate: number | null; realizedPnl: number | null; marketsTraded: number | null }

export const nansenEnabled = () => import.meta.env.VITE_NANSEN === '1'
let nansenOff = false
const nansenCache = new Map<string, Promise<NansenStats | null>>()

/** Win rate and realised PnL from Nansen via our proxy; null when unconfigured or unavailable. */
export function fetchNansenStats(wallet: string): Promise<NansenStats | null> {
  if (!nansenEnabled() || nansenOff) return Promise.resolve(null)
  const key = wallet.toLowerCase()
  let p = nansenCache.get(key)
  if (!p) {
    p = fetch('/api/nansen/prediction-market/address-summary', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: key }),
    })
      .then(async (res) => {
        // 404: not configured; 429: daily cap hit. Stop asking for the rest of the session.
        if (res.status === 404 || res.status === 429) nansenOff = true
        // 401: no signer session yet (it starts on the first trade); allow a retry later.
        if (res.status === 401) nansenCache.delete(key)
        if (!res.ok) return null
        const body = (await res.json()) as {
          data?: { win_rate?: number | null; realized_pnl_usd?: number | null; markets_traded?: number | null }[]
        }
        const row = body.data?.[0]
        if (!row) return null
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
        return { winRate: num(row.win_rate), realizedPnl: num(row.realized_pnl_usd), marketsTraded: num(row.markets_traded) }
      })
      .catch(() => null)
    nansenCache.set(key, p)
  }
  return p
}
