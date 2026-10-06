import { useSyncExternalStore } from 'react'
import { store } from '../config'

// Starred markets, newest first. Client-side only.

export type WatchItem = { slug: string; title: string; image?: string; addedAt: number }

export const WATCHLIST_KEY = 'yaynay:watchlist'
export const MAX_WATCHLIST = 200

let items: WatchItem[] = load()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function load(): WatchItem[] {
  const raw = store.get<WatchItem[]>(WATCHLIST_KEY)
  return Array.isArray(raw) ? raw.filter((w) => w && typeof w.slug === 'string') : []
}

function commit(next: WatchItem[]) {
  items = next
  store.set(WATCHLIST_KEY, items)
  emit()
}

export function isWatched(slug: string): boolean {
  return items.some((w) => w.slug === slug)
}

/** Adds the market when missing, removes it otherwise. Returns true when it is now watched. */
export function toggleWatch(item: { slug: string; title: string; image?: string }): boolean {
  if (isWatched(item.slug)) {
    commit(items.filter((w) => w.slug !== item.slug))
    return false
  }
  commit([{ slug: item.slug, title: item.title, image: item.image, addedAt: Date.now() }, ...items].slice(0, MAX_WATCHLIST))
  return true
}

export function getWatchlist(): WatchItem[] {
  return items
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useWatchlist(): WatchItem[] {
  return useSyncExternalStore(subscribe, getWatchlist, getWatchlist)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== WATCHLIST_KEY) return
    items = load()
    emit()
  })
}
