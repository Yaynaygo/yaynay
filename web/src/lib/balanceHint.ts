// Optimistic balances: when a deposit, withdrawal or trade completes, the app knows how a balance will
// move before the chain read catches up. Show the expected value until the chain reflects it.

/**
 * How a balance is expected to change after an action, in USDC/pUSD units, with the balance as it was
 * when the action started. The starting value matters: if the chain already shows the change when the
 * hint arrives, basing the hint on the current value would count it twice.
 */
export type Move = { delta: number; before: string | null }
export type BalanceDelta = { pusd?: Move; arc?: Move }

export type Hint = { base: number; delta: number; until: number }

export const HINT_MS = 3 * 60_000

export function makeHint(raw: string | null, delta: number | undefined, now = Date.now()): Hint | undefined {
  if (raw === null || !delta || !Number.isFinite(delta)) return undefined
  const base = Number(raw)
  return Number.isFinite(base) ? { base, delta, until: now + HINT_MS } : undefined
}

/** True once the chain shows at least 90% of the expected move (or the hint expired). */
export function hintSettled(raw: string | null, h: Hint, now = Date.now()): boolean {
  if (now > h.until) return true
  if (raw === null) return false
  return (Number(raw) - h.base) / h.delta >= 0.9
}

/** The balance to show: the chain value once it moved, else the expected one. */
export function applyHint(raw: string | null, h: Hint | undefined, now = Date.now()): string | null {
  if (raw === null || !h || hintSettled(raw, h, now)) return raw
  return String(Math.max(0, h.base + h.delta))
}
