import { CLOB_API } from '../config'
import type { PricePoint } from './history'

export type { PricePoint }
export type ChartRange = '1H' | '6H' | '1D' | '1W' | '1M' | 'ALL'
export type Candle = { t: number; o: number; h: number; l: number; c: number }

export const CHART_RANGES: ChartRange[] = ['1H', '6H', '1D', '1W', '1M', 'ALL']

// CLOB interval and fidelity (minutes) per range; these combinations return data, others can 400.
const RANGE_QUERY: Record<ChartRange, { interval: string; fidelity: number }> = {
  '1H': { interval: '1h', fidelity: 1 },
  '6H': { interval: '6h', fidelity: 5 },
  '1D': { interval: '1d', fidelity: 5 },
  '1W': { interval: '1w', fidelity: 30 },
  '1M': { interval: '1m', fidelity: 180 },
  ALL: { interval: 'max', fidelity: 720 },
}

/** Short ranges move fast enough to be worth refreshing while open. */
export const isShortRange = (r: ChartRange) => r === '1H' || r === '6H' || r === '1D'

/** The next longer range, used to jump out of an empty window; null for ALL. */
export function longerRange(r: ChartRange): ChartRange | null {
  const i = CHART_RANGES.indexOf(r)
  return i >= 0 && i < CHART_RANGES.length - 1 ? CHART_RANGES[i + 1] : null
}

const CACHE_MS = 30_000
const cache = new Map<string, { at: number; points: PricePoint[] }>()

/** Sorts by time, drops bad rows and keeps the last price for duplicate timestamps. */
export function cleanHistory(raw: PricePoint[]): PricePoint[] {
  const sorted = raw
    .filter((pt) => Number.isFinite(pt.t) && Number.isFinite(pt.p))
    .map((pt) => ({ t: pt.t, p: Math.min(1, Math.max(0, pt.p)) }))
    .sort((a, b) => a.t - b.t)
  const out: PricePoint[] = []
  for (const pt of sorted) {
    if (out.length && out[out.length - 1].t === pt.t) out[out.length - 1] = pt
    else out.push(pt)
  }
  return out
}

/** Price history of one outcome token for a chart range, cached per (token, range) for 30 s. */
export async function fetchChartHistory(
  tokenId: string,
  range: ChartRange,
  opts: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<PricePoint[]> {
  const key = `${tokenId}|${range}`
  const hit = cache.get(key)
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.points
  const { interval, fidelity } = RANGE_QUERY[range]
  const res = await fetch(`${CLOB_API}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}&fidelity=${fidelity}`, {
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(`Price history unavailable: ${res.status}`)
  const body = (await res.json()) as { history?: PricePoint[] }
  const points = cleanHistory(body.history ?? [])
  cache.set(key, { at: Date.now(), points })
  return points
}

const MIN = 60
const HOUR = 3600
const DAY = 86400

// Finest useful candle per range: the CLOB fidelity we request, so no candle is built from nothing.
const MIN_CANDLE: Record<ChartRange, number> = { '1H': MIN, '6H': 5 * MIN, '1D': 5 * MIN, '1W': 30 * MIN, '1M': 3 * HOUR, ALL: 12 * HOUR }
// Usual candle per range, about 40–60 candles over a full window.
const RANGE_CANDLE: Record<ChartRange, number> = { '1H': 2 * MIN, '6H': 10 * MIN, '1D': 30 * MIN, '1W': 4 * HOUR, '1M': DAY, ALL: Infinity }
const CANDLE_STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]

/**
 * Candle width for a range: 2 min (1H), 10 min (6H), 30 min (1D), 4 h (1W), 1 d (1M), and ALL splits
 * the span into ~48. When the data covers much less than the window (a young market), candles
 * shrink to keep ~48 of them, but never below the data's own resolution.
 */
export function candleSeconds(range: ChartRange, spanSeconds: number): number {
  const ideal = spanSeconds / 48
  const nice = CANDLE_STEPS.find((s) => s >= ideal) ?? CANDLE_STEPS[CANDLE_STEPS.length - 1]
  return Math.max(MIN_CANDLE[range], Math.min(RANGE_CANDLE[range], nice))
}

/**
 * Buckets points into OHLC candles of `bucket` seconds. Each candle opens at the previous close so
 * the bodies join up; empty buckets are skipped.
 */
export function toCandles(points: PricePoint[], bucket: number): Candle[] {
  const out: Candle[] = []
  let cur: Candle | null = null
  for (const pt of points) {
    const t = Math.floor(pt.t / bucket) * bucket
    if (!cur || cur.t !== t) {
      const open: number = cur ? cur.c : pt.p
      cur = { t, o: open, h: Math.max(open, pt.p), l: Math.min(open, pt.p), c: pt.p }
      out.push(cur)
    } else {
      cur.h = Math.max(cur.h, pt.p)
      cur.l = Math.min(cur.l, pt.p)
      cur.c = pt.p
    }
  }
  return out
}

/** Y domain for prices: padded around min/max, at least `minSpan` wide and kept inside [0, 1]. */
export function priceDomain(values: number[], minSpan = 0.1): [number, number] {
  if (!values.length) return [0, 1]
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const pad = Math.max((max - min) * 0.12, 0.01)
  let lo = min - pad
  let hi = max + pad
  if (hi - lo < minSpan) {
    const mid = (min + max) / 2
    lo = mid - minSpan / 2
    hi = mid + minSpan / 2
  }
  if (lo < 0) {
    hi = Math.min(1, hi - lo)
    lo = 0
  }
  if (hi > 1) {
    lo = Math.max(0, lo - (hi - 1))
    hi = 1
  }
  return [lo, hi]
}

const PRICE_STEPS = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5]

/** Round price gridlines inside [lo, hi]: the finest step that gives at most `maxTicks` lines. */
export function priceTicks(lo: number, hi: number, maxTicks = 5): number[] {
  for (const step of PRICE_STEPS) {
    const first = Math.ceil(lo / step - 1e-9)
    const last = Math.floor(hi / step + 1e-9)
    if (last - first + 1 <= maxTicks) {
      const ticks: number[] = []
      // `+ 0` turns -0 into 0.
      for (let i = first; i <= last; i++) ticks.push(Math.round(i * step * 1e6) / 1e6 + 0)
      return ticks
    }
  }
  return [lo, hi]
}

const TIME_STEPS = [
  5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 91 * DAY, 182 * DAY, 365 * DAY,
]

const localOffset = (t: number) => new Date(t * 1000).getTimezoneOffset() * 60

/** Spacing between time labels: the finest round step that fits at most `maxTicks` of them. */
export function timeStep(t0: number, t1: number, maxTicks = 6): number {
  const span = Math.max(1, t1 - t0)
  return TIME_STEPS.find((s) => span / s + 1 <= maxTicks) ?? span / (maxTicks - 1)
}

/**
 * Time axis ticks between t0 and t1 (unix seconds), aligned to round local times. `tzOffset`
 * (seconds, Date#getTimezoneOffset sign) exists for tests.
 */
export function timeTicks(t0: number, t1: number, maxTicks = 6, tzOffset = localOffset(t0)): number[] {
  if (!(t1 > t0)) return []
  const step = timeStep(t0, t1, maxTicks)
  // Work in local seconds so day steps land on local midnight.
  const local0 = t0 - tzOffset
  const ticks: number[] = []
  for (let l = Math.ceil(local0 / step) * step; l + tzOffset <= t1; l += step) ticks.push(l + tzOffset)
  return ticks
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad2 = (n: number) => String(n).padStart(2, '0')

/** Axis label for a tick `step` seconds apart: `HH:mm` within a day (`MMM d` at midnight), `MMM d` beyond. */
export function timeLabel(t: number, step: number): string {
  const d = new Date(t * 1000)
  const midnight = d.getHours() === 0 && d.getMinutes() === 0
  return step < DAY && !midnight ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** Tooltip label: `MMM d, HH:mm`. */
export function fullTimeLabel(t: number): string {
  const d = new Date(t * 1000)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Index of the timestamp closest to `t` in an ascending array; -1 when empty. */
export function nearestIndex(ts: number[], t: number): number {
  if (!ts.length) return -1
  let lo = 0
  let hi = ts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ts[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && t - ts[lo - 1] <= ts[lo] - t ? lo - 1 : lo
}

/** Percentage for headers and tags: whole numbers, with <1% / >99% at the edges. */
export function formatPct(p: number, decimals = 0): string {
  const v = p * 100
  if (v > 0 && v < 1) return '<1%'
  if (v < 100 && v > 99) return '>99%'
  return `${v.toFixed(decimals)}%`
}
