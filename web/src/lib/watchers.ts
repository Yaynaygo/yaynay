import { useCallback } from 'react'
import { DATA_API, RECURRING_ROUND_RE, store } from '../config'
import { useVisiblePolling } from './alerts'
import { notify, type NotifyInput } from './notifications'

// Watches the user's Polymarket positions: a ping when a position wins (becomes redeemable with
// value) and when a held market ends within 24 hours. Each event notifies once per wallet.

export const POSITION_POLL_MS = 120_000
const DAY_MS = 24 * 3600 * 1000
const MAX_NOTIFIED = 400
const notifiedKey = (wallet: string) => `yaynay:notified-positions:${wallet.toLowerCase()}`

/** The fields the watcher needs; listPositions() drops end_date and event_slug, so we read v2 directly. */
export type WatchedPosition = {
  asset: string
  conditionId: string
  title: string
  outcome: string
  size: number
  currentValue: number
  redeemable: boolean
  endDate?: string
  eventSlug?: string
}

type V2Row = {
  token_id: string
  condition_id: string
  title: string
  outcome: string
  current_size: number
  current_value: number
  redeemable: boolean
  end_date?: string | null
  event_slug?: string | null
  slug?: string | null
}

async function fetchStatus(wallet: string, status: 'OPEN' | 'REDEEMABLE'): Promise<WatchedPosition[]> {
  const res = await fetch(`${DATA_API}/v2/positions?user=${wallet}&status=${status}&limit=100`)
  if (!res.ok) throw new Error(`Data API positions failed: ${res.status}`)
  const body = (await res.json()) as { data?: V2Row[] | null }
  return (body.data ?? []).map((p) => ({
    asset: p.token_id,
    conditionId: p.condition_id,
    title: p.title,
    outcome: p.outcome,
    size: p.current_size,
    currentValue: p.current_value,
    redeemable: p.redeemable,
    endDate: p.end_date ?? undefined,
    eventSlug: p.event_slug || p.slug || undefined,
  }))
}

export async function fetchWatchedPositions(wallet: string): Promise<WatchedPosition[]> {
  const [open, redeemable] = await Promise.all([fetchStatus(wallet, 'OPEN'), fetchStatus(wallet, 'REDEEMABLE')])
  return [...open, ...redeemable]
}

/** "2026-10-06" is a calendar date: treat it as the end of that UTC day. Full timestamps pass through. */
export function parseEndDate(s?: string): number | null {
  if (!s) return null
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59Z`) : Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** Pure: which notifications to send for these positions, given the keys already notified. */
export function positionEvents(positions: WatchedPosition[], notified: ReadonlySet<string>, now = Date.now()): { key: string; n: NotifyInput }[] {
  const out: { key: string; n: NotifyInput }[] = []
  const seen = new Set(notified)
  for (const p of positions) {
    if (!(p.size >= 0.01)) continue
    // Redeemable positions with no value are losses: nothing to celebrate.
    if (p.redeemable && p.currentValue >= 0.01) {
      const key = `win:${p.asset}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        key,
        n: {
          id: `${key}`,
          kind: 'win',
          title: 'You called it!',
          detail: `${p.title} · ${p.outcome} pays $${p.currentValue.toFixed(2)}. Redeem it in Portfolio.`,
          href: '#/portfolio',
        },
      })
      continue
    }
    if (p.redeemable || RECURRING_ROUND_RE.test(p.title)) continue
    const end = parseEndDate(p.endDate)
    if (end === null || end <= now || end - now > DAY_MS) continue
    // One heads-up per market, even when both outcomes are held.
    const key = `ending:${p.conditionId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      n: {
        id: key,
        kind: 'ending',
        title: 'Ending within 24h',
        detail: `${p.title} · you hold ${p.outcome}`,
        href: p.eventSlug ? `#/market/${encodeURIComponent(p.eventSlug)}` : '#/portfolio',
      },
    })
  }
  return out
}

/** Polls once and notifies new events; exported for manual refreshes. */
export async function checkPositions(wallet: string): Promise<number> {
  const positions = await fetchWatchedPositions(wallet)
  const key = notifiedKey(wallet)
  const notified = new Set(store.get<string[]>(key) ?? [])
  const events = positionEvents(positions, notified)
  if (events.length === 0) return 0
  for (const e of events) notified.add(e.key)
  store.set(key, [...notified].slice(-MAX_NOTIFIED))
  for (const e of events) notify(e.n)
  return events.length
}

/** Mount once at app level with the Polymarket (proxy) wallet; pass null when signed out. */
export function usePositionWatcher(wallet: string | null) {
  const task = useCallback(() => (wallet ? checkPositions(wallet) : undefined), [wallet])
  useVisiblePolling(wallet ? task : null, POSITION_POLL_MS)
}
