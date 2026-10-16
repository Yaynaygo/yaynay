import { useSyncExternalStore } from 'react'

// Buys that filled but that Polymarket's Data API hasn't indexed yet (it lags by up to a minute).
// The market page shows them right away as "Confirming…" rows, then drops each one once the
// position's size has grown by the bought shares, or after a few minutes regardless.

export type PendingFill = {
  /** Outcome token id. */
  asset: string
  conditionId: string
  outcome: string
  title: string
  shares: number
  /** USD paid, excluding the fee. */
  cost: number
  /** Unix ms. */
  at: number
  /** Position size before this buy, recorded the first time the position list sees the fill. */
  baseSize?: number
}

export const PENDING_TTL_MS = 3 * 60_000

let fills: PendingFill[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function addPendingFill(f: Omit<PendingFill, 'baseSize'>) {
  fills = [...fills, f]
  emit()
}

/** Records the pre-buy size for fills that don't have one yet. */
export function setBaseSizes(sizeOf: (asset: string) => number) {
  if (!fills.some((f) => f.baseSize === undefined)) return
  fills = fills.map((f) => (f.baseSize === undefined ? { ...f, baseSize: sizeOf(f.asset) } : f))
  emit()
}

/** Drops fills the Data API now reflects, and any older than the TTL. */
export function settleFills(sizeOf: (asset: string) => number, now = Date.now()) {
  const next = fills.filter((f) => !isSettled(f, sizeOf(f.asset), now))
  if (next.length !== fills.length) {
    fills = next
    emit()
  }
}

export function isSettled(f: PendingFill, size: number, now: number): boolean {
  if (now - f.at > PENDING_TTL_MS) return true
  return f.baseSize !== undefined && size >= f.baseSize + f.shares - 0.01
}

export function usePendingFills(): PendingFill[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => fills,
  )
}

/** Current fills, outside React (tests). */
export const peekFills = () => fills

/** Test hook. */
export function resetPendingFills() {
  fills = []
  emit()
}
