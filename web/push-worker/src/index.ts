// YayNay push checker: a Cloudflare Worker on a one-minute cron. It reads armed price alerts from
// D1, checks them against Polymarket CLOB midpoints, and sends each crossing once as an encrypted
// Web Push. Pages Functions cannot run cron, hence this separate Worker on the same database.
import {
  claimAlert,
  deleteSubscriptionById,
  fetchMidpointChunk,
  loadArmedTokens,
  loadDueAlerts,
  loadSubscriptions,
  markDelivered,
  MIDPOINT_CHUNK,
  purgeStale,
  recordMisses,
  refreshCounts,
  releaseAlert,
  type D1Db,
  type StoredAlert,
} from '../../server/pushStore.ts'
import { sendPush, vapidAuthorization, type PushMessage, type VapidConfig } from '../../server/webpush.ts'

export type Env = {
  DB: D1Db
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  /** `mailto:` contact for push services; falls back to SITE_URL. */
  VAPID_SUBJECT?: string
  SITE_URL?: string
  /** Outbound requests per run (Workers Free allows 50 subrequests per invocation). */
  SUBREQUEST_BUDGET?: string
}

/** Subrequests kept free for pushes when midpoint chunks would use the whole budget. */
const PUSH_RESERVE = 10

export function shouldFire(alert: Pick<StoredAlert, 'op' | 'price'>, price: number | undefined): boolean {
  if (price === undefined || !Number.isFinite(price)) return false
  return alert.op === 'above' ? price >= alert.price - 1e-9 : price <= alert.price + 1e-9
}

/** 0.705 → "70.5¢", 0.7 → "70¢" (same as the app). */
export function formatCents(price: number): string {
  const c = Math.round(price * 1000) / 10
  return `${Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1)}¢`
}

export function alertMessage(a: StoredAlert, price: number): PushMessage {
  return {
    title: `${a.outcome} hit ${formatCents(price)}`,
    body: a.title,
    url: `/#/market/${encodeURIComponent(a.slug)}`,
    tag: `alert:${a.id}`,
    alertId: a.id,
    price,
  }
}

type Deps = { fetcher?: typeof fetch; now?: number; log?: (msg: string) => void }

export type RunSummary = {
  /** Distinct tokens with armed alerts. */
  armed: number
  priced: number
  due: number
  sent: number
  gone: number
  failed: number
}

export async function runCheck(env: Env, deps: Deps = {}): Promise<RunSummary> {
  const fetcher = deps.fetcher ?? fetch
  const now = deps.now ?? Date.now()
  const log = deps.log ?? ((m: string) => console.log(m))
  const summary: RunSummary = { armed: 0, priced: 0, due: 0, sent: 0, gone: 0, failed: 0 }

  const subject = env.VAPID_SUBJECT || env.SITE_URL
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !subject) {
    log('[push] VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (or SITE_URL) must be set')
    return summary
  }
  const vapid: VapidConfig = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject }
  let budget = Math.max(2, Number(env.SUBREQUEST_BUDGET) || 45)

  // Hourly housekeeping (recounts too); otherwise refresh the cached totals every 10 minutes.
  const minute = new Date(now).getUTCMinutes()
  if (minute === 0) await purgeStale(env.DB, now)
  else if (minute % 10 === 0) await refreshCounts(env.DB)

  const armed = await loadArmedTokens(env.DB)
  summary.armed = armed.length
  if (armed.length === 0) return summary

  // Midpoints, 50 tokens per request. If there are more chunks than budget, rotate which ones run.
  const tokens = armed.map((a) => a.tokenId).sort()
  const chunks: string[][] = []
  for (let i = 0; i < tokens.length; i += MIDPOINT_CHUNK) chunks.push(tokens.slice(i, i + MIDPOINT_CHUNK))
  const maxChunks = Math.max(1, Math.min(chunks.length, budget - PUSH_RESERVE))
  const start = chunks.length > maxChunks ? Math.floor(now / 60_000) % chunks.length : 0
  const picked = Array.from({ length: maxChunks }, (_, i) => chunks[(start + i) % chunks.length])
  budget -= picked.length
  const prices: Record<string, number> = {}
  const checked: string[] = []
  await Promise.all(
    picked.map(async (chunk) => {
      try {
        Object.assign(prices, await fetchMidpointChunk(chunk, fetcher))
        checked.push(...chunk)
      } catch (e) {
        log(`[push] midpoints failed: ${e instanceof Error ? e.message : e}`)
      }
    }),
  )
  summary.priced = Object.keys(prices).length

  // Tokens the CLOB answered for but had no midpoint (unknown or closed market) count a miss.
  const hadMisses = new Set(armed.filter((a) => a.misses > 0).map((a) => a.tokenId))
  await recordMisses(
    env.DB,
    checked.filter((t) => prices[t] === undefined),
    checked.filter((t) => prices[t] !== undefined && hadMisses.has(t)),
  )

  const due = (await loadDueAlerts(env.DB, prices)).filter((a) => shouldFire(a, prices[a.tokenId]))
  summary.due = due.length
  if (due.length === 0) return summary

  const subs = await loadSubscriptions(
    env.DB,
    due.map((a) => a.subId),
  )
  const auths = new Map<string, string>()
  const goneSubs = new Set<string>()
  for (const a of due) {
    // Out of budget: the rest stay armed and go out next minute.
    if (budget <= 0) break
    const sub = subs.get(a.subId)
    if (!sub || goneSubs.has(sub.id)) continue
    const price = prices[a.tokenId]
    if (!(await claimAlert(env.DB, a.subId, a.id, price, now))) continue
    budget--
    try {
      const origin = new URL(sub.endpoint).origin
      let authorization = auths.get(origin)
      if (!authorization) {
        authorization = await vapidAuthorization(sub.endpoint, vapid, now)
        auths.set(origin, authorization)
      }
      const res = await sendPush(sub, alertMessage(a, price), vapid, { ttl: 3600, urgency: 'high', fetcher, authorization })
      if (res.ok) {
        summary.sent++
        await markDelivered(env.DB, sub.id, now)
      } else if (res.gone) {
        // The browser unsubscribed or the subscription expired: forget it and its alerts.
        summary.gone++
        goneSubs.add(sub.id)
        await deleteSubscriptionById(env.DB, sub.id)
      } else if (res.status === 429 || res.status >= 500) {
        summary.failed++
        await releaseAlert(env.DB, a.subId, a.id)
      } else {
        // Other 4xx (bad payload, auth): retrying won't help; leave it fired.
        summary.failed++
        log(`[push] push service refused alert ${a.id}: HTTP ${res.status}`)
      }
    } catch (e) {
      summary.failed++
      log(`[push] send failed: ${e instanceof Error ? e.message : e}`)
      await releaseAlert(env.DB, a.subId, a.id)
    }
  }
  return summary
}

type ScheduledCtx = { waitUntil(p: Promise<unknown>): void }

export default {
  async scheduled(_event: unknown, env: Env, ctx: ScheduledCtx) {
    ctx.waitUntil(
      runCheck(env).then((s) => {
        if (s.due > 0 || s.failed > 0) console.log(`[push] ${JSON.stringify(s)}`)
      }),
    )
  },
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 })
  },
}
