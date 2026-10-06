import { describe, expect, it } from 'vitest'
import { aggregate, bestRank, leanHeadline, maskWallet, mergeLeaderboards, publicName, type RawHolder } from './smartMoney'

const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

describe('mergeLeaderboards', () => {
  it('dedupes wallets across periods and keeps both ranks', () => {
    const traders = mergeLeaderboards(
      [
        { wallet: w(1).toUpperCase().replace('0X', '0x'), name: 'alpha', rank: 1, pnl: 1000 },
        { wallet: w(2), name: 'beta', rank: 2, pnl: 500 },
      ],
      [
        { wallet: w(1), name: 'alpha', rank: 7, pnl: 90 },
        { wallet: w(3), name: 'gamma', rank: 1, pnl: 300 },
      ],
    )
    expect(traders).toHaveLength(3)
    const alpha = traders.find((t) => t.wallet === w(1))!
    expect(alpha).toMatchObject({ rankAll: 1, pnlAll: 1000, rankMonth: 7, pnlMonth: 90 })
  })

  it('drops malformed wallets and prefers a real username over an address-like one', () => {
    const traders = mergeLeaderboards(
      [
        { wallet: 'nope', name: 'x', rank: 1, pnl: 1 },
        { wallet: w(4), name: `${w(4)}-1759935795465`, rank: 2, pnl: 1 },
      ],
      [{ wallet: w(4), name: 'delta', rank: 3, pnl: 1 }],
    )
    expect(traders).toHaveLength(1)
    expect(traders[0].name).toBe('delta')
  })
})

describe('bestRank', () => {
  it('picks the better of the two ranks', () => {
    expect(bestRank({ wallet: w(1), name: '', rankAll: 40, pnlAll: 9, rankMonth: 3, pnlMonth: 2 })).toEqual({ rank: 3, period: 'month', pnl: 2 })
    expect(bestRank({ wallet: w(1), name: '', rankAll: 3, pnlAll: 9 })).toEqual({ rank: 3, period: 'all', pnl: 9 })
  })
})

describe('publicName / maskWallet', () => {
  it('never returns a full wallet', () => {
    expect(publicName(w(5), '', `${w(5)}-123`, undefined)).toBe('0x0000…0005')
    expect(publicName(w(5), undefined, 'Embellished-Prevalence')).toBe('Embellished Prevalence')
    expect(maskWallet(w(5))).toHaveLength(11)
  })
})

describe('aggregate', () => {
  const traders = mergeLeaderboards(
    [
      { wallet: w(1), name: 'alpha', rank: 1, pnl: 1000 },
      { wallet: w(2), name: 'beta', rank: 2, pnl: 800 },
      { wallet: w(3), name: 'gamma', rank: 3, pnl: 600 },
    ],
    [{ wallet: w(4), name: 'delta', rank: 1, pnl: 50 }],
  )
  const names = ['Yes', 'No']

  it('weights the lean by position value at the current price', () => {
    const holders: RawHolder[] = [
      { wallet: w(1), outcomeIndex: 0, shares: 1000 }, // $200 Yes
      { wallet: w(2), outcomeIndex: 1, shares: 100 }, // $80 No
      { wallet: w(9), outcomeIndex: 1, shares: 1e6 }, // not smart money
    ]
    const s = aggregate(traders, holders, [0.2, 0.8], names)
    expect(s.holders.map((h) => h.name)).toEqual(['alpha', 'beta'])
    expect(s.sides.map((x) => x.traders)).toEqual([1, 1])
    expect(s.totalValue).toBeCloseTo(280)
    expect(s.lean?.name).toBe('Yes')
    expect(s.lean?.pct).toBeCloseTo(200 / 280)
    expect(leanHeadline(s)).toBe('Smart money leans Yes 71%')
  })

  it('counts a hedged trader once, on the net side, with the net value', () => {
    const holders: RawHolder[] = [
      { wallet: w(1), outcomeIndex: 0, shares: 500 }, // $250
      { wallet: w(1), outcomeIndex: 1, shares: 100 }, // $50
    ]
    const s = aggregate(traders, holders, [0.5, 0.5], names)
    expect(s.holders).toHaveLength(1)
    expect(s.holders[0]).toMatchObject({ outcomeIndex: 0, shares: 500, value: 200, hedged: true })
    expect(s.sides[0].traders).toBe(1)
    expect(s.sides[1].traders).toBe(0)
  })

  it('does not double count duplicate rows', () => {
    const row: RawHolder = { wallet: w(2), outcomeIndex: 1, shares: 100 }
    const s = aggregate(traders, [row, { ...row, wallet: row.wallet.toUpperCase().replace('0X', '0x') }], [0.5, 0.5], names)
    expect(s.holders).toHaveLength(1)
    expect(s.sides[1].shares).toBe(100)
  })

  it('ignores dust and out-of-range outcomes, and reports no lean when empty', () => {
    const s = aggregate(
      traders,
      [
        { wallet: w(3), outcomeIndex: 0, shares: 4 },
        { wallet: w(4), outcomeIndex: 5, shares: 1000 },
      ],
      [0.5, 0.5],
      names,
    )
    expect(s.holders).toEqual([])
    expect(s.lean).toBeNull()
    expect(leanHeadline(s)).toBe('No smart money here yet')
  })

  it('ranks holders by value, then by trader rank', () => {
    const s = aggregate(
      traders,
      [
        { wallet: w(3), outcomeIndex: 0, shares: 100 },
        { wallet: w(1), outcomeIndex: 1, shares: 100 },
        { wallet: w(4), outcomeIndex: 0, shares: 300 },
      ],
      [0.5, 0.5],
      names,
    )
    expect(s.holders.map((h) => h.name)).toEqual(['delta', 'alpha', 'gamma'])
    expect(leanHeadline(s)).toBe('Smart money leans Yes 80%')
  })

  it('calls a near-even book split', () => {
    const s = aggregate(
      traders,
      [
        { wallet: w(1), outcomeIndex: 0, shares: 100 },
        { wallet: w(2), outcomeIndex: 1, shares: 90 },
      ],
      [0.5, 0.5],
      names,
    )
    expect(leanHeadline(s)).toBe('Smart money is split')
  })
})
