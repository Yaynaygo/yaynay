/** Gross payout multiple for buying at `price` (a share pays $1): 0.62 → "1.61x". */
export function multiplier(price: number): string {
  if (price <= 0) return '—'
  const m = 1 / price
  return `${m >= 10 ? m.toFixed(0) : m.toFixed(2)}x`
}

export function cents(price: number): string {
  return `${(price * 100).toFixed(price < 0.1 ? 1 : 0)}¢`
}

export function volume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`
  return `$${Math.round(v)}`
}

/** "Ends in 3h", "Ends Oct 29", "Ended". Uses the market's own timestamp, not the device clock's timezone guess. */
export function endsLabel(iso: string): string {
  const end = Date.parse(iso)
  if (!Number.isFinite(end)) return ''
  const ms = end - Date.now()
  if (ms <= 0) return 'Awaiting result'
  const h = ms / 3_600_000
  if (h < 1) return `Ends in ${Math.max(1, Math.round(ms / 60_000))}m`
  if (h < 48) return `Ends in ${Math.round(h)}h`
  return `Ends ${new Date(end).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: h > 24 * 300 ? 'numeric' : undefined })}`
}
