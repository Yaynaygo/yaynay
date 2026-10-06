import { describe, expect, it } from 'vitest'
import { mergeActivity, toActivityItem, type ActivityItem } from './activity'
import { withBaseline, callerStyle, callingCard, compactUsd, drawable, leanOf, matchesFilter, netFlow, periodChange, timeAgo } from './dashboard'

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: Math.random().toString(36),
  kind: 'BUY',
  title: 'm',
  detail: '',
  usd: 1,
  timestamp: 0,
  ...over,
})

// Noon local time on a given day offset from a fixed date, as unix seconds.
const day = (offset: number) => new Date(2026, 9, 6 + offset, 12).getTime() / 1000

describe('periodChange', () => {
  const pts = [
    { t: 1, p: 10 },
    { t: 2, p: 4 },
    { t: 3, p: 7 },
  ]
  it('measures short windows from their first sample', () => {
    expect(periodChange(pts, '1D')).toBe(-3)
  })
  it('treats ALL as the all-time figure', () => {
    expect(periodChange(pts, 'ALL')).toBe(7)
  })
  it('is zero without data', () => {
    expect(periodChange([], '1W')).toBe(0)
  })
})

describe('withBaseline', () => {
  const now = 1_000_000
  it('starts a new account from break-even', () => {
    const pts = [
      { t: now - 3 * 3600, p: -0.08 },
      { t: now, p: -0.15 },
    ]
    const out = withBaseline(pts, '1W', now)
    expect(out[0]).toEqual({ t: now - 4 * 3600, p: 0 })
    expect(periodChange(out, '1W')).toBeCloseTo(-0.15)
  })
  it('leaves a series that covers the whole window alone', () => {
    const pts = [
      { t: now - 86_400, p: 10 },
      { t: now, p: 12 },
    ]
    expect(withBaseline(pts, '1D', now)).toBe(pts)
    expect(periodChange(pts, '1D')).toBe(2)
  })
  it('always anchors ALL at zero', () => {
    const out = withBaseline([{ t: now, p: -0.15 }], 'ALL', now)
    expect(out.map((x) => x.p)).toEqual([0, -0.15])
  })
  it('skips the anchor when the series already starts at zero', () => {
    const pts = [{ t: now - 3600, p: 0 }]
    expect(withBaseline(pts, '1W', now)).toBe(pts)
  })
})

describe('drawable', () => {
  it('keeps real series', () => {
    const pts = [
      { t: 1, p: 1 },
      { t: 2, p: 2 },
    ]
    expect(drawable(pts)).toBe(pts)
  })
  it('turns one sample into a flat line ending now', () => {
    const out = drawable([{ t: 1000, p: -0.15 }], 5000)
    expect(out).toHaveLength(2)
    expect(out.every((x) => x.p === -0.15)).toBe(true)
    expect(out[1].t).toBe(5000)
    expect(out[0].t).toBeLessThan(out[1].t)
  })
  it('draws a zero line with no samples', () => {
    expect(drawable([], 5000).map((x) => x.p)).toEqual([0, 0])
  })
})

describe('leanOf', () => {
  it('maps binary outcomes', () => {
    expect(leanOf('Yes')).toBe('yay')
    expect(leanOf('Up')).toBe('yay')
    expect(leanOf('over')).toBe('yay')
    expect(leanOf('No')).toBe('nay')
    expect(leanOf('Down')).toBe('nay')
    expect(leanOf('Under')).toBe('nay')
  })
  it('treats named outcomes as picks', () => {
    expect(leanOf('Atlanta Braves')).toBe('pick')
    expect(leanOf(undefined)).toBe('pick')
  })
})

describe('callerStyle', () => {
  it('buckets by average entry', () => {
    expect(callerStyle(0.2)?.id).toBe('underdog')
    expect(callerStyle(0.5)?.id).toBe('balanced')
    expect(callerStyle(0.85)?.id).toBe('favorite')
    expect(callerStyle(null)).toBeNull()
  })
})

describe('callingCard', () => {
  it('sums volume over buys and sells and ignores claims', () => {
    const card = callingCard(
      [
        item({ kind: 'BUY', usd: 5, outcome: 'Yes', price: 0.8, timestamp: day(0) }),
        item({ kind: 'SELL', usd: 3, outcome: 'Yes', price: 0.9, timestamp: day(0) }),
        item({ kind: 'REDEEM', usd: 100, timestamp: day(0) }),
      ],
      day(0),
    )
    expect(card.trades).toBe(2)
    expect(card.volume).toBe(8)
  })

  it('splits buys into yay, nay and picks by stake', () => {
    const card = callingCard([
      item({ usd: 6, outcome: 'Yes' }),
      item({ usd: 2, outcome: 'No' }),
      item({ usd: 2, outcome: 'Croatia' }),
      item({ kind: 'SELL', usd: 50, outcome: 'No' }),
    ])
    expect(card.lean.yay).toBeCloseTo(0.6)
    expect(card.lean.nay).toBeCloseTo(0.2)
    expect(card.lean.pick).toBeCloseTo(0.2)
  })

  it('weights the average entry by stake', () => {
    const card = callingCard([item({ usd: 9, price: 0.9 }), item({ usd: 1, price: 0.1 })])
    expect(card.avgEntry).toBeCloseTo(0.82)
    expect(card.style?.id).toBe('favorite')
  })

  it('has no style without priced buys', () => {
    const card = callingCard([item({ kind: 'SELL', price: 0.5 })])
    expect(card.avgEntry).toBeNull()
    expect(card.style).toBeNull()
    expect(card.lean).toEqual({ yay: 0, nay: 0, pick: 0 })
  })

  it('counts a streak of consecutive trading days ending today or yesterday', () => {
    const items = [day(0), day(-1), day(-2), day(-4)].map((t) => item({ timestamp: t }))
    expect(callingCard(items, day(0)).streak).toBe(3)
    expect(callingCard(items, day(1)).streak).toBe(3)
    expect(callingCard(items, day(2)).streak).toBe(0)
  })
})

describe('activity helpers', () => {
  it('filters by group', () => {
    expect(matchesFilter(item({ kind: 'SELL' }), 'trades')).toBe(true)
    expect(matchesFilter(item({ kind: 'REDEEM' }), 'claims')).toBe(true)
    expect(matchesFilter(item({ kind: 'WITHDRAW' }), 'transfers')).toBe(true)
    expect(matchesFilter(item({ kind: 'BUY' }), 'transfers')).toBe(false)
    expect(matchesFilter(item({ kind: 'OTHER', id: 'topup-1' }), 'transfers')).toBe(true)
    expect(matchesFilter(item({ kind: 'OTHER' }), 'all')).toBe(true)
  })

  it('nets cash flow into the trading balance', () => {
    expect(netFlow([item({ kind: 'BUY', usd: 5 }), item({ kind: 'SELL', usd: 2 }), item({ kind: 'DEPOSIT', usd: 10 })])).toBe(7)
  })

  it('merges pages newest first without duplicates', () => {
    const a = item({ id: 'a', timestamp: 1 })
    const b = item({ id: 'b', timestamp: 3 })
    const c = item({ id: 'c', timestamp: 2 })
    expect(mergeActivity([a, b], [b, c]).map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('maps Data API rows with market details', () => {
    const row = toActivityItem(
      {
        type: 'TRADE',
        side: 'BUY',
        size: 6.02,
        usdc_size: 5.04,
        price: 0.83,
        outcome: 'Yes',
        title: 'Fed',
        icon: 'https://x/i.png',
        event_slug: 'fed',
        timestamp: 10,
        transaction_hash: '0xabc',
      },
      0,
    )
    expect(row).toMatchObject({ kind: 'BUY', usd: 5.04, outcome: 'Yes', price: 0.83, shares: 6.02, eventSlug: 'fed', icon: 'https://x/i.png' })
    expect(row.detail).toBe('6.02 Yes shares @ 83.0¢')
    const claim = toActivityItem({ type: 'REDEEM', usdc_size: 3, timestamp: 11, outcome: 'Yes', price: 1 }, 1)
    expect(claim.kind).toBe('REDEEM')
    expect(claim.outcome).toBeUndefined()
  })
})

describe('formatting', () => {
  it('formats relative time', () => {
    expect(timeAgo(100, 120)).toBe('just now')
    expect(timeAgo(0, 300)).toBe('5m ago')
    expect(timeAgo(0, 3 * 3600)).toBe('3h ago')
    expect(timeAgo(0, 2 * 86_400)).toBe('2d ago')
  })
  it('compacts dollars', () => {
    expect(compactUsd(950)).toBe('$950.00')
    expect(compactUsd(12_400)).toBe('$12.4k')
    expect(compactUsd(-3_100_000)).toBe('−$3.10M')
  })
})
