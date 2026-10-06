import { DATA_API, STORAGE, store } from '../config'

export type ActivityKind = 'BUY' | 'SELL' | 'REDEEM' | 'DEPOSIT' | 'WITHDRAW' | 'OTHER'

export type ActivityItem = {
  id: string
  kind: ActivityKind
  title: string
  detail: string
  usd: number
  timestamp: number
  href?: string
  hrefLabel?: string
  /** Market image, for trades and claims. */
  icon?: string
  /** Event slug, so the row can link to the market page. */
  eventSlug?: string
  /** Outcome traded ("Yes", "No", "Over", a team name…). */
  outcome?: string
  /** Fill price, 0–1. */
  price?: number
  shares?: number
}

type V2Activity = {
  type: string
  side?: 'BUY' | 'SELL'
  size?: number
  usdc_size?: number
  price?: number
  title?: string
  outcome?: string
  icon?: string
  event_slug?: string
  timestamp: number
  transaction_hash?: string
}

export type ActivityPage = { items: ActivityItem[]; next?: string }

export function toActivityItem(a: V2Activity, i: number): ActivityItem {
  const kind: ActivityKind = a.type === 'TRADE' ? (a.side ?? 'OTHER') : a.type === 'REDEEM' ? 'REDEEM' : 'OTHER'
  const price = a.price ? ` @ ${(a.price * 100).toFixed(1)}¢` : ''
  const trade = kind === 'BUY' || kind === 'SELL'
  return {
    id: `${a.transaction_hash ?? a.timestamp}-${i}`,
    kind,
    title: a.title ?? a.type,
    detail: trade
      ? `${(a.size ?? 0).toFixed(2)} ${a.outcome ?? ''} shares${price}`
      : kind === 'REDEEM'
        ? 'Winnings claimed'
        : a.type.toLowerCase(),
    usd: a.usdc_size ?? 0,
    timestamp: a.timestamp,
    href: a.transaction_hash ? `https://polygonscan.com/tx/${a.transaction_hash}` : undefined,
    hrefLabel: 'Polygon',
    icon: a.icon || undefined,
    eventSlug: a.event_slug || undefined,
    outcome: trade ? a.outcome || undefined : undefined,
    price: trade ? a.price : undefined,
    shares: trade ? a.size : undefined,
  }
}

/** One page of a Polymarket wallet's trades and redemptions (Data API v2), newest first. */
export async function fetchPolymarketActivityPage(wallet: string, cursor?: string, limit = 100): Promise<ActivityPage> {
  const params = new URLSearchParams({ user: wallet, limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const res = await fetch(`${DATA_API}/v2/activity?${params}`)
  if (!res.ok) throw new Error(`Activity unavailable: ${res.status}`)
  const body = (await res.json()) as {
    data?: V2Activity[] | null
    pagination?: { has_more?: boolean; next_cursor?: string }
  }
  const items = (body.data ?? []).map((a, i) => toActivityItem(a, i))
  const next = body.pagination?.has_more ? body.pagination.next_cursor : undefined
  return { items, next: next || undefined }
}

/** Trades and redemptions of a Polymarket wallet (Data API v2). */
export async function fetchPolymarketActivity(wallet: string): Promise<ActivityItem[]> {
  return (await fetchPolymarketActivityPage(wallet, undefined, 50)).items
}

/** Deposits and withdrawals made from this browser, which the Polymarket APIs don't show. */
export function loadLocalActivity(arcAddress: string): ActivityItem[] {
  return store.get<ActivityItem[]>(`${STORAGE.activity}:${arcAddress.toLowerCase()}`) ?? []
}

export function recordActivity(arcAddress: string, item: ActivityItem) {
  const key = `${STORAGE.activity}:${arcAddress.toLowerCase()}`
  const items = (store.get<ActivityItem[]>(key) ?? []).filter((x) => x.id !== item.id)
  store.set(key, [item, ...items].slice(0, 50))
}

/** Newest first, without duplicate ids (a reloaded page can overlap the previous one). */
export function mergeActivity(...lists: ActivityItem[][]): ActivityItem[] {
  const seen = new Set<string>()
  const out: ActivityItem[] = []
  for (const a of lists.flat()) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    out.push(a)
  }
  return out.sort((a, b) => b.timestamp - a.timestamp)
}
