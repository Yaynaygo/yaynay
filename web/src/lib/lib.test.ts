import { describe, expect, it } from 'vitest'
import { quoteBuy } from './quote'
import { classify } from './geoblock'
import { roundToTick } from './markets'

describe('quoteBuy', () => {
  it('reproduces the fee Polymarket charged on our first mainnet trade', () => {
    // $1 into asks at 0.1¢ with feeRate 0.07 → Polymarket charged 0.06993 pUSD.
    const q = quoteBuy([{ price: 0.001, size: 28817 }], 1, { rate: 0.07, exponent: 1 })!
    expect(q.shares).toBeCloseTo(1000, 6)
    expect(q.fee).toBeCloseTo(0.06993, 8)
    expect(q.filledUsd).toBeCloseTo(1, 9)
  })

  it('walks several levels and reports the worst price', () => {
    const q = quoteBuy(
      [
        { price: 0.5, size: 1 },
        { price: 0.52, size: 100 },
      ],
      10,
      { rate: 0.05, exponent: 1 },
    )!
    expect(q.worstPrice).toBe(0.52)
    expect(q.avgPrice).toBeGreaterThan(0.5)
    expect(q.avgPrice).toBeLessThan(0.52)
  })

  it('reports a thin book and an empty one', () => {
    const q = quoteBuy([{ price: 0.4, size: 5 }], 10, { rate: 0, exponent: 1 })!
    expect(q.filledUsd).toBeCloseTo(2, 9)
    expect(quoteBuy([], 10, { rate: 0, exponent: 1 })).toBeNull()
  })
})

describe('classify (geoblock)', () => {
  it('maps jurisdictions to access levels', () => {
    expect(classify('AZ', 'BA', false)).toBe('open')
    expect(classify('TR', '34', false)).toBe('open')
    expect(classify('US', 'NY', true)).toBe('close-only')
    expect(classify('CA', 'ON', true)).toBe('close-only')
    expect(classify('CA', 'NS', false)).toBe('open')
    expect(classify('IE', 'D', false)).toBe('close-only')
    expect(classify('IR', '', true)).toBe('blocked')
    expect(classify('UA', '43', true)).toBe('blocked')
    // An unlisted country the API blocks fails closed.
    expect(classify('XX', '', true)).toBe('close-only')
  })
})

describe('roundToTick', () => {
  it('rounds to the market tick', () => {
    expect(roundToTick(0.5234, 0.01)).toBe('0.52')
    expect(roundToTick(0.0006, 0.001)).toBe('0.001')
    expect(roundToTick(0.999, 0.001)).toBe('0.999')
  })
})

import { pageWindow } from './pager'

describe('pageWindow', () => {
  it('shows every page when there are few', () => {
    expect(pageWindow(0, 4)).toEqual([0, 1, 2, 3])
  })
  it('keeps first, last and neighbours with gaps', () => {
    expect(pageWindow(10, 40)).toEqual([0, null, 9, 10, 11, null, 39])
  })
  it('fills a one-page gap instead of an ellipsis', () => {
    expect(pageWindow(3, 40)).toEqual([0, 1, 2, 3, 4, null, 39])
  })
  it('widens near the end', () => {
    expect(pageWindow(39, 40)).toEqual([0, null, 36, 37, 38, 39])
  })
})

import { parseRoute, routeHref } from './router'
import { depth } from './marketData'

describe('market routes', () => {
  it('round-trips a market with a selected outcome', () => {
    const route = { name: 'market', slug: 'fed-decision', marketId: '123', side: 'no' } as const
    expect(parseRoute(routeHref(route))).toEqual(route)
  })
  it('keeps plain market links short', () => {
    expect(routeHref({ name: 'market', slug: 'a b' })).toBe('#/market/a%20b')
    expect(parseRoute('#/market/a%20b')).toEqual({ name: 'market', slug: 'a b', marketId: undefined, side: undefined })
  })
  it('ignores unknown sides and routes', () => {
    expect(parseRoute('#/market/x?o=maybe')).toMatchObject({ side: undefined })
    expect(parseRoute('#/nope')).toEqual({ name: 'markets' })
    expect(parseRoute('#/quests')).toEqual({ name: 'quests' })
  })
})

describe('order book depth', () => {
  it('accumulates sizes and totals', () => {
    const rows = depth([{ price: 0.5, size: 10 }, { price: 0.51, size: 4 }, { price: 0.52, size: 1 }], 2)
    expect(rows).toEqual([
      { price: 0.5, size: 10, total: 5, cumulative: 10 },
      { price: 0.51, size: 4, total: 2.04, cumulative: 14 },
    ])
  })
})

import { diversify } from './history'

describe('live tape diversify', () => {
  const t = (title: string, outcome: string, usd: number, ts: number, side: 'BUY' | 'SELL' = 'BUY') =>
    ({ side, outcome, outcomeIndex: 0, title, eventSlug: title.split(':')[0], usd, price: 0.5, timestamp: ts })
  it('merges fills of the same call and caps calls per event', () => {
    const out = diversify([t('A: m1', 'Yes', 10, 5), t('A: m1', 'Yes', 15, 7), t('A: m2', 'No', 3, 6), t('A: m3', 'Yes', 4, 4), t('B: m1', 'No', 8, 3)])
    expect(out.map((x) => [x.title, x.usd, x.timestamp])).toEqual([
      ['A: m1', 25, 7],
      ['A: m2', 3, 6],
      ['B: m1', 8, 3],
    ])
  })
})

import { applyHint, makeHint } from './balanceHint'

describe('optimistic balances', () => {
  it('shows the expected balance until the chain catches up', () => {
    const h = makeHint('3.10', 3.937, 0)!
    expect(applyHint('3.10', h, 1000)).toBe(String(3.1 + 3.937))
    expect(applyHint('7.04', h, 2000)).toBe('7.04')
  })
  it('handles decreases and expiry', () => {
    const h = makeHint('7.04', -5, 0)!
    expect(Number(applyHint('7.04', h, 1000))).toBeCloseTo(2.04)
    expect(applyHint('7.04', h, h.until + 1)).toBe('7.04')
    expect(makeHint(null, 5)).toBeUndefined()
  })
})

import { sellableShares } from './sellPosition'

describe('sellableShares', () => {
  it('floors to cents without float artifacts', () => {
    expect(sellableShares(5.29)).toBe(5.29)
    expect(sellableShares(6.024096)).toBe(6.02)
    expect(sellableShares(0.009)).toBe(0)
  })
})
