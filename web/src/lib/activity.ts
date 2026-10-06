import { DATA_API, STORAGE, store } from '../config'

export type ActivityItem = {
  id: string
  kind: 'BUY' | 'SELL' | 'REDEEM' | 'DEPOSIT' | 'WITHDRAW' | 'OTHER'
  title: string
  detail: string
  usd: number
  timestamp: number
  href?: string
  hrefLabel?: string
}

type V2Activity = {
  type: string
  side?: 'BUY' | 'SELL'
  size?: number
  usdc_size?: number
  price?: number
  title?: string
  outcome?: string
  timestamp: number
  transaction_hash?: string
}

/** Trades and redemptions of a Polymarket wallet (Data API v2). */
export async function fetchPolymarketActivity(wallet: string): Promise<ActivityItem[]> {
  const res = await fetch(`${DATA_API}/v2/activity?user=${wallet}&limit=50`)
  if (!res.ok) throw new Error(`Activity unavailable: ${res.status}`)
  const body = (await res.json()) as { data?: V2Activity[] | null }
  return (body.data ?? []).map((a, i) => {
    const kind: ActivityItem['kind'] =
      a.type === 'TRADE' ? (a.side ?? 'OTHER') : a.type === 'REDEEM' ? 'REDEEM' : 'OTHER'
    const price = a.price ? ` @ ${(a.price * 100).toFixed(1)}¢` : ''
    return {
      id: `${a.transaction_hash ?? a.timestamp}-${i}`,
      kind,
      title: a.title ?? a.type,
      detail:
        kind === 'BUY' || kind === 'SELL'
          ? `${(a.size ?? 0).toFixed(2)} ${a.outcome ?? ''} shares${price}`
          : kind === 'REDEEM'
            ? 'Winnings claimed'
            : a.type.toLowerCase(),
      usd: a.usdc_size ?? 0,
      timestamp: a.timestamp,
      href: a.transaction_hash ? `https://polygonscan.com/tx/${a.transaction_hash}` : undefined,
      hrefLabel: 'Polygon',
    }
  })
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
