import { useSyncExternalStore } from 'react'
import { store } from '../config'

// Notification inbox: everything the app wants the user to see later (fills, deposits, alerts,
// wins). Client-side only, persisted in localStorage and synced across tabs.

export type NotificationKind = 'trade' | 'deposit' | 'withdraw' | 'win' | 'alert' | 'ending' | 'info' | 'error'

export type AppNotification = {
  id: string
  kind: NotificationKind
  title: string
  detail?: string
  /** Internal '#/…' route or an external URL: where clicking the notification goes. */
  href?: string
  /** A secondary external link shown under it, e.g. the transaction on an explorer. */
  link?: { href: string; label: string }
  createdAt: number
  read: boolean
}

export type NotifyInput = Omit<AppNotification, 'id' | 'createdAt' | 'read'> & {
  /** Stable id: a second notify with the same id is ignored (dedupe). */
  id?: string
  createdAt?: number
}

export const NOTIFICATIONS_KEY = 'yaynay:notifications'
export const BROWSER_NOTIF_KEY = 'yaynay:browser-notifications'
export const MAX_NOTIFICATIONS = 60

let items: AppNotification[] = load()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function load(): AppNotification[] {
  const raw = store.get<AppNotification[]>(NOTIFICATIONS_KEY)
  return Array.isArray(raw) ? raw.filter((n) => n && typeof n.id === 'string' && typeof n.title === 'string') : []
}

function commit(next: AppNotification[]) {
  items = next
  store.set(NOTIFICATIONS_KEY, items)
  emit()
}

/** Pure: newest first, deduped by id, capped. */
export function addToList(list: AppNotification[], n: AppNotification, cap = MAX_NOTIFICATIONS): AppNotification[] {
  if (list.some((x) => x.id === n.id)) return list
  return [n, ...list].slice(0, cap)
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Adds a notification to the inbox (and the OS tray when enabled and the tab is hidden). Returns its id. */
export function notify(input: NotifyInput): string {
  const n: AppNotification = {
    id: input.id ?? newId(),
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    href: input.href,
    link: input.link,
    createdAt: input.createdAt ?? Date.now(),
    read: false,
  }
  const next = addToList(items, n)
  if (next === items) return n.id
  commit(next)
  showBrowserNotification(n)
  return n.id
}

export function markRead(id: string) {
  if (!items.some((n) => n.id === id && !n.read)) return
  commit(items.map((n) => (n.id === id ? { ...n, read: true } : n)))
}

export function markAllRead() {
  if (!items.some((n) => !n.read)) return
  commit(items.map((n) => (n.read ? n : { ...n, read: true })))
}

export function clearNotifications() {
  commit([])
}

/** Test-only reset of the in-memory store. */
export function _resetNotifications(list: AppNotification[] = []) {
  items = list
  emit()
}

export function getNotifications(): AppNotification[] {
  return items
}

let snapshot = { items, unread: 0 }
function getSnapshot() {
  if (snapshot.items !== items) snapshot = { items, unread: items.filter((n) => !n.read).length }
  return snapshot
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useNotifications(): { items: AppNotification[]; unread: number } {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Another tab wrote the inbox or the browser setting: pick it up.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === NOTIFICATIONS_KEY) {
      items = load()
      emit()
    } else if (e.key === BROWSER_NOTIF_KEY) {
      emit()
    }
  })
}

// ---------- browser (OS) notifications ----------

export type BrowserNotifState = 'unsupported' | 'denied' | 'off' | 'on'

const supported = () => typeof window !== 'undefined' && 'Notification' in window

export function browserNotifState(): BrowserNotifState {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return Notification.permission === 'granted' && store.get<boolean>(BROWSER_NOTIF_KEY) === true ? 'on' : 'off'
}

/** Asks for permission (must run from a user gesture) and turns OS notifications on when granted. */
export async function enableBrowserNotifications(): Promise<BrowserNotifState> {
  if (!supported()) return 'unsupported'
  let permission = Notification.permission
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission()
    } catch {
      permission = Notification.permission
    }
  }
  store.set(BROWSER_NOTIF_KEY, permission === 'granted' ? true : null)
  emit()
  return browserNotifState()
}

export function disableBrowserNotifications() {
  store.set(BROWSER_NOTIF_KEY, null)
  emit()
}

export function useBrowserNotifications(): BrowserNotifState {
  return useSyncExternalStore(subscribe, browserNotifState, () => 'unsupported' as const)
}

function showBrowserNotification(n: AppNotification) {
  if (browserNotifState() !== 'on' || typeof document === 'undefined' || document.visibilityState !== 'hidden') return
  try {
    const os = new Notification(n.title, { body: n.detail, icon: '/favicon.svg', tag: n.id })
    os.onclick = () => {
      window.focus()
      openHref(n.href)
      markRead(n.id)
      os.close()
    }
  } catch {
    // Some platforms (Android Chrome) only allow notifications from a service worker.
  }
}

/** Internal '#/…' routes change the hash; anything else opens in a new tab. */
export function openHref(href?: string) {
  if (!href || typeof window === 'undefined') return
  if (href.startsWith('#')) window.location.hash = href
  else window.open(href, '_blank', 'noopener,noreferrer')
}
