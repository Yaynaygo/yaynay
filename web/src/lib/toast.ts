import { useSyncExternalStore } from 'react'
import { notify, type NotificationKind } from './notifications'

// Minimal toast store: transaction progress stays visible wherever the user has scrolled.
export type ToastKind = 'info' | 'success' | 'error'
export type Toast = { id: number; kind: ToastKind; title: string; detail?: string; href?: string; linkLabel?: string }

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
// Toast ids already copied into the notification inbox (success toasts usually update an info toast).
const inboxed = new Set<number>()

function inboxKind(title: string): NotificationKind {
  if (/quest/i.test(title)) return 'info'
  if (/deposit|top-up/i.test(title)) return 'deposit'
  if (/withdraw/i.test(title)) return 'withdraw'
  return 'trade'
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

/** Shows a toast; errors stay until dismissed, others auto-hide. Returns the id for updates. */
export function toast(t: Omit<Toast, 'id'>, id?: number): number {
  const toastId = id ?? nextId++
  const next = { ...t, id: toastId }
  toasts = toasts.some((x) => x.id === toastId) ? toasts.map((x) => (x.id === toastId ? next : x)) : [...toasts.slice(-3), next]
  emit()
  if (t.kind === 'success' && !inboxed.has(toastId)) {
    inboxed.add(toastId)
    const kind = inboxKind(t.title)
    // Clicking opens the related page in the app; the explorer link (if any) sits underneath.
    const page = /quest/i.test(t.title) ? '#/quests' : kind === 'trade' ? '#/portfolio' : kind === 'deposit' || kind === 'withdraw' ? '#/wallet' : undefined
    notify({
      kind,
      title: t.title,
      detail: t.detail,
      href: page ?? t.href,
      link: page && t.href ? { href: t.href, label: t.linkLabel ?? 'View transaction' } : undefined,
    })
  }
  if (t.kind !== 'error') {
    setTimeout(() => {
      if (toasts.find((x) => x.id === toastId) === next) dismissToast(toastId)
    }, t.kind === 'success' ? 7000 : 12000)
  }
  return toastId
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toasts,
  )
}

/** Turns wallet and SDK errors into one readable sentence. */
export function friendlyError(e: unknown): string {
  const err = e as { name?: string; shortMessage?: string; message?: string; code?: number; cause?: { code?: number } }
  const code = err?.code ?? err?.cause?.code
  const text = err?.shortMessage || err?.message || String(e)
  if (code === 4001 || /user rejected|user denied|rejected the request|cancelled/i.test(text)) {
    return 'You cancelled the request in your wallet.'
  }
  if (/insufficient funds/i.test(text)) return 'Not enough balance in your wallet to cover this transaction.'
  if (/chain mismatch|does not match the target chain/i.test(text)) return 'Your wallet is on a different network. Switch networks and try again.'
  return text.split('\n')[0].slice(0, 240)
}
