import { useEffect, useSyncExternalStore } from 'react'
import { CLOB_API, store } from '../config'
import { notify } from './notifications'

// One-shot price alerts on a single outcome token, checked against the CLOB midpoint.

export type AlertOp = 'above' | 'below'

export type PriceAlert = {
  id: string
  tokenId: string
  /** Event slug, for the '#/market/<slug>' link. */
  slug: string
  /** Market title shown with the alert. */
  title: string
  outcome: string
  op: AlertOp
  /** Target probability, 0–1. */
  price: number
  createdAt: number
  firedAt?: number
}

export const ALERTS_KEY = 'yaynay:price-alerts'
export const MAX_ACTIVE_ALERTS = 100
export const MAX_FIRED_ALERTS = 20
export const ALERT_POLL_MS = 30_000

let alerts: PriceAlert[] = load()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function load(): PriceAlert[] {
  const raw = store.get<PriceAlert[]>(ALERTS_KEY)
  return Array.isArray(raw) ? raw.filter((a) => a && typeof a.tokenId === 'string' && Number.isFinite(a.price)) : []
}

function commit(next: PriceAlert[]) {
  alerts = next
  store.set(ALERTS_KEY, alerts)
  emit()
}

/** Pure: true once the price has reached the target in the alert's direction. */
export function shouldFire(alert: Pick<PriceAlert, 'op' | 'price' | 'firedAt'>, price: number | null | undefined): boolean {
  if (alert.firedAt || price === null || price === undefined || !Number.isFinite(price)) return false
  // Tolerance absorbs float noise such as 0.7 vs 0.7000000001.
  return alert.op === 'above' ? price >= alert.price - 1e-9 : price <= alert.price + 1e-9
}

/** 0.705 → "70.5¢", 0.7 → "70¢". */
export function formatCents(price: number): string {
  const c = Math.round(price * 1000) / 10
  return `${Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1)}¢`
}

/** Pure: keeps every active alert (capped) and only the most recent fired ones. */
export function pruneAlerts(list: PriceAlert[]): PriceAlert[] {
  const active = list.filter((a) => !a.firedAt).slice(-MAX_ACTIVE_ALERTS)
  const fired = list
    .filter((a) => a.firedAt)
    .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0))
    .slice(0, MAX_FIRED_ALERTS)
  return [...active, ...fired]
}

export function addAlert(input: Omit<PriceAlert, 'id' | 'createdAt' | 'firedAt'>): PriceAlert {
  const price = Math.min(0.999, Math.max(0.001, input.price))
  // Same token, direction and target already armed: keep the existing one.
  const dup = alerts.find((a) => !a.firedAt && a.tokenId === input.tokenId && a.op === input.op && Math.abs(a.price - price) < 1e-9)
  if (dup) return dup
  const alert: PriceAlert = { ...input, price, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() }
  commit(pruneAlerts([...alerts, alert]))
  return alert
}

export function removeAlert(id: string) {
  if (!alerts.some((a) => a.id === id)) return
  commit(alerts.filter((a) => a.id !== id))
}

export function getAlerts(): PriceAlert[] {
  return alerts
}

/** Alerts (active and fired) on one outcome token. */
export function alertsFor(tokenId: string): PriceAlert[] {
  return alerts.filter((a) => a.tokenId === tokenId)
}

/** Test-only reset of the in-memory store. */
export function _resetAlerts(list: PriceAlert[] = []) {
  alerts = list
  emit()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useAlerts(): PriceAlert[] {
  return useSyncExternalStore(subscribe, getAlerts, getAlerts)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== ALERTS_KEY) return
    alerts = load()
    emit()
  })
}

/** Batched CLOB midpoints: POST /midpoints → { [tokenId]: "0.685" }. Tokens without a book are omitted. */
export async function fetchMidpoints(tokenIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const unique = [...new Set(tokenIds)]
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50)
    const res = await fetch(`${CLOB_API}/midpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk.map((token_id) => ({ token_id }))),
    })
    if (!res.ok) throw new Error(`CLOB midpoints failed: ${res.status}`)
    const body = (await res.json()) as Record<string, string>
    for (const [id, v] of Object.entries(body ?? {})) {
      const n = Number(v)
      if (Number.isFinite(n)) out[id] = n
    }
  }
  return out
}

/** Checks every armed alert once; fires (and marks) the ones whose target was reached. */
export async function checkAlerts(getPrices: (ids: string[]) => Promise<Record<string, number>> = fetchMidpoints): Promise<PriceAlert[]> {
  const armed = alerts.filter((a) => !a.firedAt)
  if (armed.length === 0) return []
  const prices = await getPrices(armed.map((a) => a.tokenId))
  const now = Date.now()
  // Re-read after the await: the user may have removed an alert meanwhile.
  const due = alerts.filter((a) => shouldFire(a, prices[a.tokenId]))
  if (due.length === 0) return []
  const dueIds = new Set(due.map((a) => a.id))
  commit(pruneAlerts(alerts.map((a) => (dueIds.has(a.id) ? { ...a, firedAt: now } : a))))
  for (const a of due) notifyFired(a, prices[a.tokenId])
  return due
}

function notifyFired(a: PriceAlert, price: number | null) {
  notify({
    // Same id (and OS notification tag) as the server push, so the inbox never shows it twice.
    id: `alert:${a.id}`,
    kind: 'alert',
    title: price === null ? `${a.outcome} reached your price` : `${a.outcome} hit ${formatCents(price)}`,
    detail: `${a.title} · you asked for ${a.op} ${formatCents(a.price)}`,
    href: `#/market/${encodeURIComponent(a.slug)}`,
  })
}

/** Marks alerts the server already fired (Web Push) and adds them to the inbox. Unknown or fired ids are ignored. */
export function markAlertsFired(list: { id: string; price: number | null; firedAt?: number }[]) {
  const byId = new Map(list.map((f) => [f.id, f]))
  const due = alerts.filter((a) => !a.firedAt && byId.has(a.id))
  if (due.length === 0) return
  const now = Date.now()
  const ids = new Set(due.map((a) => a.id))
  commit(pruneAlerts(alerts.map((a) => (ids.has(a.id) ? { ...a, firedAt: byId.get(a.id)?.firedAt ?? now } : a))))
  for (const a of due) notifyFired(a, byId.get(a.id)?.price ?? null)
}

/** Calls `l` whenever the alert list changes (any tab). Returns an unsubscribe function. */
export const onAlertsChange = (l: () => void) => subscribe(l)

/**
 * Runs `task` every `ms` while the tab is visible, and right away when it becomes visible again.
 * Shared by the alert and position watchers.
 */
export function useVisiblePolling(task: (() => void | Promise<unknown>) | null, ms: number) {
  useEffect(() => {
    if (!task || typeof document === 'undefined') return
    let busy = false
    const run = () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      Promise.resolve()
        .then(task)
        .catch(() => {
          // Network hiccup: try again on the next tick.
        })
        .finally(() => {
          busy = false
        })
    }
    run()
    const timer = window.setInterval(run, ms)
    const onVis = () => document.visibilityState === 'visible' && run()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [task, ms])
}

const runAlertCheck = () => checkAlerts()

/** Mount once at app level: checks price alerts every 30 s while the tab is visible. */
export function useAlertWatcher() {
  useVisiblePolling(runAlertCheck, ALERT_POLL_MS)
}
