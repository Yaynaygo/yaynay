import { useSyncExternalStore } from 'react'
import { store } from '../config'
import { getAlerts, markAlertsFired, onAlertsChange, type PriceAlert } from './alerts'

// Web Push price alerts: lets the server check the user's armed alerts while every YayNay tab is
// closed. Only the push subscription and the alert targets leave the browser; turning it off
// deletes both server-side. The in-tab watcher in alerts.ts keeps running either way.

export type PushState = 'unsupported' | 'checking' | 'unconfigured' | 'denied' | 'off' | 'on'

export const PUSH_KEY = 'yaynay:push-alerts'
const SYNCED_KEY = 'yaynay:push-synced'
const MAX_SYNCED = 50
const SYNC_DEBOUNCE_MS = 1500
/** Re-sync at least this often so the server knows the subscription is still in use. */
const RESYNC_MS = 24 * 3600_000

/** undefined while loading, null when the server has push disabled. */
let vapidKey: string | null | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

const enabled = () => store.get<boolean>(PUSH_KEY) === true

export function pushState(): PushState {
  if (!pushSupported()) return 'unsupported'
  if (vapidKey === undefined) return 'checking'
  if (vapidKey === null) return 'unconfigured'
  if (Notification.permission === 'denied') return 'denied'
  return enabled() && Notification.permission === 'granted' ? 'on' : 'off'
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function usePushState(): PushState {
  return useSyncExternalStore(subscribe, pushState, () => 'unsupported' as const)
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const bin = atob(key.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false
  const x = new Uint8Array(a)
  return x.every((v, i) => v === b[i])
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return navigator.serviceWorker.ready
}

/**
 * Deletes a subscription's server copy (alerts included), then the browser subscription.
 * Throws and keeps the browser subscription if the server delete fails, so nothing is orphaned.
 */
export async function dropOldSubscription(sub: Pick<PushSubscription, 'endpoint' | 'unsubscribe'>, post = postJson): Promise<void> {
  const res = await post('/api/push/unsubscribe', { endpoint: sub.endpoint })
  if (!res.ok && res.status !== 404) throw new Error('Could not replace your old alert subscription. Try again.')
  await sub.unsubscribe().catch(() => false)
}

/** The browser's push subscription for our current VAPID key, created when missing. */
async function ensureSubscription(): Promise<PushSubscription> {
  if (!vapidKey) throw new Error('Push alerts are not available right now.')
  const reg = await registration()
  const key = keyBytes(vapidKey)
  const existing = await reg.pushManager.getSubscription()
  if (existing && sameKey(existing.options.applicationServerKey, key)) return existing
  // Rotated server key: delete the old subscription's server copy first, then start over.
  if (existing) await dropOldSubscription(existing)
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
}

type AlertTarget = Pick<PriceAlert, 'id' | 'tokenId' | 'op' | 'price' | 'title' | 'slug' | 'outcome'>

/** The armed alerts the server should watch (newest 50), in the exact shape the API accepts. */
export function pushTargets(list: PriceAlert[]): AlertTarget[] {
  return list
    .filter((a) => !a.firedAt && /^[0-9]{1,90}$/.test(a.tokenId) && a.slug && a.title && a.outcome && a.price >= 0.001 && a.price <= 0.999)
    .slice(-MAX_SYNCED)
    .map((a) => ({ id: a.id, tokenId: a.tokenId, op: a.op, price: a.price, title: a.title.slice(0, 300), slug: a.slug.slice(0, 200), outcome: a.outcome.slice(0, 80) }))
}

async function digest(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

/** Sends the current alert set to the server unless it already has exactly this set (shared across tabs). */
async function syncNow(force = false) {
  if (pushState() !== 'on') return
  const sub = await ensureSubscription()
  const json = sub.toJSON()
  const body = { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, alerts: pushTargets(getAlerts()) }
  const hash = await digest(JSON.stringify(body))
  const last = store.get<{ h: string; at: number }>(SYNCED_KEY)
  if (!force && last?.h === hash && Date.now() - last.at < RESYNC_MS) return
  const res = await postJson('/api/push/subscribe', body)
  const out = (await res.json().catch(() => ({}))) as { error?: string; fired?: { id: string; firedAt: number; price: number | null }[] }
  if (!res.ok) throw new Error(out.error ?? `Could not save alerts (${res.status}).`)
  store.set(SYNCED_KEY, { h: hash, at: Date.now() })
  // Alerts the server fired while no tab was open.
  if (out.fired?.length) markAlertsFired(out.fired)
}

let timer: number | undefined
function scheduleSync(ms = SYNC_DEBOUNCE_MS) {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    syncNow().catch(() => {
      // Offline or rate-limited: the next alert change or page load tries again.
    })
  }, ms)
}

/** Turns server push on. Must run from a user gesture (permission prompt). */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported() || !vapidKey) return pushState()
  let permission = Notification.permission
  if (permission === 'default') permission = await Notification.requestPermission().catch(() => Notification.permission)
  if (permission !== 'granted') {
    emit()
    return pushState()
  }
  store.set(PUSH_KEY, true)
  try {
    await syncNow(true)
  } catch (e) {
    // Leave nothing behind if the server never got the subscription.
    await disablePush().catch(() => undefined)
    throw e
  } finally {
    emit()
  }
  return pushState()
}

/** Turns server push off and deletes the subscription and its alerts on the server. */
export async function disablePush(): Promise<void> {
  const reg = pushSupported() ? await navigator.serviceWorker.getRegistration('/') : undefined
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    const res = await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint })
    if (!res.ok && res.status !== 404) throw new Error('Could not delete your alerts from the server. Try again.')
    await sub.unsubscribe().catch(() => false)
  }
  await reg?.unregister().catch(() => false)
  store.set(PUSH_KEY, null)
  store.set(SYNCED_KEY, null)
  emit()
}

function onWorkerMessage(e: MessageEvent) {
  const d = e.data as { type?: string; alertId?: unknown; price?: unknown; url?: unknown } | null
  if (d?.type === 'yaynay:alert-fired' && typeof d.alertId === 'string') {
    markAlertsFired([{ id: d.alertId, price: typeof d.price === 'number' ? d.price : null }])
  } else if (d?.type === 'yaynay:open' && typeof d.url === 'string' && d.url.startsWith('/#/')) {
    window.location.hash = d.url.slice(1)
  }
}

async function init() {
  navigator.serviceWorker.addEventListener('message', onWorkerMessage)
  // A 404 means the operator switched server push off (as opposed to a network blip).
  let switchedOff = false
  try {
    const res = await fetch('/api/push/key')
    switchedOff = res.status === 404
    const body = res.ok ? ((await res.json()) as { key?: unknown }) : null
    vapidKey = typeof body?.key === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(body.key) ? body.key : null
  } catch {
    vapidKey = null
  }
  emit()
  if (!vapidKey) {
    // Push was turned off on the server: drop this browser's subscription and service worker too.
    if (switchedOff && enabled()) disablePush().catch(() => undefined)
    return
  }
  onAlertsChange(() => {
    if (pushState() === 'on') scheduleSync()
  })
  window.addEventListener('storage', (e) => {
    if (e.key === PUSH_KEY) emit()
  })
  if (enabled()) {
    if (Notification.permission === 'granted') scheduleSync(0)
    // Permission revoked in browser settings: the server copy is now useless, delete it.
    else if (Notification.permission === 'denied') disablePush().catch(() => undefined)
  }
}

if (pushSupported()) void init()
