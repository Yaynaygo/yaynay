import { describe, expect, it } from 'vitest'
import {
  candleSeconds,
  cleanHistory,
  formatPct,
  longerRange,
  nearestIndex,
  priceDomain,
  priceTicks,
  timeLabel,
  timeTicks,
  toCandles,
} from './chart'

describe('cleanHistory', () => {
  it('sorts, clamps and keeps the last price for a repeated timestamp', () => {
    expect(
      cleanHistory([
        { t: 3, p: 0.5 },
        { t: 1, p: 1.2 },
        { t: 3, p: 0.6 },
        { t: 2, p: Number.NaN },
      ]),
    ).toEqual([
      { t: 1, p: 1 },
      { t: 3, p: 0.6 },
    ])
  })
})

describe('toCandles', () => {
  it('buckets points and opens each candle at the previous close', () => {
    const pts = [
      { t: 0, p: 0.5 },
      { t: 30, p: 0.55 },
      { t: 59, p: 0.52 },
      { t: 60, p: 0.48 },
      { t: 100, p: 0.6 },
      // 120–179 is empty and skipped
      { t: 200, p: 0.4 },
    ]
    expect(toCandles(pts, 60)).toEqual([
      { t: 0, o: 0.5, h: 0.55, l: 0.5, c: 0.52 },
      { t: 60, o: 0.52, h: 0.6, l: 0.48, c: 0.6 },
      { t: 180, o: 0.6, h: 0.6, l: 0.4, c: 0.4 },
    ])
  })

  it('returns nothing for no points', () => {
    expect(toCandles([], 60)).toEqual([])
  })
})

describe('candleSeconds', () => {
  it('targets 40–60 candles over a full window', () => {
    expect(candleSeconds('1H', 3600)).toBe(120)
    expect(candleSeconds('6H', 6 * 3600)).toBe(600)
    expect(candleSeconds('1D', 86400)).toBe(1800)
    expect(candleSeconds('1W', 7 * 86400)).toBe(4 * 3600)
    expect(candleSeconds('1M', 30 * 86400)).toBe(86400)
  })

  it('splits ALL into about 48 candles', () => {
    const n = (100 * 86400) / candleSeconds('ALL', 100 * 86400)
    expect(n).toBeGreaterThan(30)
    expect(n).toBeLessThanOrEqual(48)
  })

  it('shrinks candles for a young market but not below the data resolution', () => {
    // Two days of data: smaller candles than the range default, floored at the fidelity.
    expect(candleSeconds('1M', 2 * 86400)).toBe(3 * 3600)
    expect(candleSeconds('1W', 2 * 86400)).toBe(3600)
    expect(candleSeconds('1D', 600)).toBe(300)
    expect(candleSeconds('ALL', 600)).toBe(12 * 3600)
  })
})

describe('priceDomain', () => {
  it('pads around the data', () => {
    const [lo, hi] = priceDomain([0.3, 0.7])
    expect(lo).toBeCloseTo(0.252)
    expect(hi).toBeCloseTo(0.748)
  })

  it('enforces a minimum span of 10 points around a flat line', () => {
    const [lo, hi] = priceDomain([0.5, 0.5])
    expect(lo).toBeCloseTo(0.45)
    expect(hi).toBeCloseTo(0.55)
  })

  it('stays inside [0, 1] and keeps the span near the edges', () => {
    const [lo, hi] = priceDomain([0.01, 0.02])
    expect(lo).toBe(0)
    expect(hi).toBeCloseTo(0.1)
    const [lo2, hi2] = priceDomain([0.99, 1])
    expect(hi2).toBe(1)
    expect(lo2).toBeCloseTo(0.9)
  })

  it('falls back to the full range without data', () => {
    expect(priceDomain([])).toEqual([0, 1])
  })
})

describe('priceTicks', () => {
  it('picks round steps with at most five lines', () => {
    expect(priceTicks(0.45, 0.55)).toEqual([0.46, 0.48, 0.5, 0.52, 0.54])
    expect(priceTicks(0, 1)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(priceTicks(0.252, 0.748)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7])
  })

  it('always returns between two and five ticks for spans of at least 10 points', () => {
    for (let lo = 0; lo <= 0.9; lo += 0.037) {
      for (const span of [0.1, 0.17, 0.33, 0.6]) {
        const hi = Math.min(1, lo + span)
        const n = priceTicks(lo, hi).length
        expect(n).toBeGreaterThanOrEqual(2)
        expect(n).toBeLessThanOrEqual(5)
      }
    }
  })
})

describe('timeTicks', () => {
  it('aligns hour ticks inside a one-day window', () => {
    const t0 = 1_700_000_000
    const ticks = timeTicks(t0, t0 + 86400, 6, 0)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks.length).toBeLessThanOrEqual(6)
    for (const t of ticks) {
      expect(t % (6 * 3600)).toBe(0)
      expect(t).toBeGreaterThanOrEqual(t0)
    }
  })

  it('lands day ticks on local midnight', () => {
    const t0 = 1_700_000_000
    const offset = -3 * 3600 // UTC+3
    const ticks = timeTicks(t0, t0 + 7 * 86400, 6, offset)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    for (const t of ticks) expect((t - offset) % 86400).toBe(0)
  })

  it('is empty for a zero-length window', () => {
    expect(timeTicks(5, 5)).toEqual([])
  })
})

describe('timeLabel', () => {
  it('uses clock time for sub-day steps and dates otherwise', () => {
    const noon = new Date(2026, 9, 6, 12, 30).getTime() / 1000
    const midnight = new Date(2026, 9, 6).getTime() / 1000
    expect(timeLabel(noon, 3600)).toBe('12:30')
    expect(timeLabel(midnight, 3600)).toBe('Oct 6')
    expect(timeLabel(noon, 86400)).toBe('Oct 6')
  })
})

describe('nearestIndex', () => {
  const ts = [10, 20, 30, 40]
  it('finds the closest timestamp, preferring the earlier one on ties', () => {
    expect(nearestIndex(ts, 0)).toBe(0)
    expect(nearestIndex(ts, 24)).toBe(1)
    expect(nearestIndex(ts, 25)).toBe(1)
    expect(nearestIndex(ts, 26)).toBe(2)
    expect(nearestIndex(ts, 99)).toBe(3)
    expect(nearestIndex([], 5)).toBe(-1)
  })
})

describe('formatPct / longerRange', () => {
  it('formats edges', () => {
    expect(formatPct(0.62)).toBe('62%')
    expect(formatPct(0.004)).toBe('<1%')
    expect(formatPct(0.996)).toBe('>99%')
    expect(formatPct(0)).toBe('0%')
    expect(formatPct(0.6234, 1)).toBe('62.3%')
  })

  it('steps to the next longer range', () => {
    expect(longerRange('1H')).toBe('6H')
    expect(longerRange('ALL')).toBe(null)
  })
})
