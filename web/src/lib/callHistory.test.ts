import { describe, expect, it } from 'vitest'
import { callResult, cumulative, summarize, toClosedCall, type ClosedCall } from './callHistory'

const call = (over: Partial<ClosedCall>): ClosedCall => ({
  asset: 'a',
  conditionId: 'c',
  title: 't',
  outcome: 'Yes',
  shares: 10,
  avgPrice: 0.5,
  cost: 5,
  realizedPnl: 0,
  ret: 0,
  result: 'sold',
  closedAt: 1,
  openedAt: 0,
  ...over,
})

describe('callResult', () => {
  it('marks resolved markets by realized P&L', () => {
    expect(callResult(1, 4.2)).toBe('won')
    expect(callResult(0, -5)).toBe('lost')
    expect(callResult(1, -0.3)).toBe('lost')
  })
  it('treats an unresolved price as sold early', () => {
    expect(callResult(0.62, 1.1)).toBe('sold')
  })
})

describe('toClosedCall', () => {
  it('computes return on cost including fees', () => {
    const c = toClosedCall({
      token_id: 't',
      condition_id: 'c',
      title: 'Will it?',
      outcome: 'Yes',
      total_size: 10,
      avg_price: 0.4,
      total_cost_usdc: 4.04,
      entry_fees_usdc: 0.04,
      current_price: 1,
      realized_pnl: 5.96,
      last_event_at: 20,
      first_entry_at: 10,
    })
    expect(c.result).toBe('won')
    expect(c.cost).toBeCloseTo(4.04)
    expect(c.ret).toBeCloseTo(5.96 / 4.04)
  })
  it('uses shares × average price when the reported cost is only fees', () => {
    const c = toClosedCall({
      token_id: 't',
      condition_id: 'c',
      title: 'x',
      outcome: 'No',
      total_size: 8,
      avg_price: 0.25,
      total_cost_usdc: 0,
      current_price: 0,
      realized_pnl: -2,
      last_event_at: 2,
      first_entry_at: 1,
    })
    expect(c.cost).toBe(2)
    expect(c.ret).toBe(-1)
    expect(c.result).toBe('lost')
  })
})

describe('summarize', () => {
  it('totals realized P&L, win rate, best and worst', () => {
    const s = summarize([
      call({ asset: '1', realizedPnl: 3, cost: 5 }),
      call({ asset: '2', realizedPnl: -2, cost: 4 }),
      call({ asset: '3', realizedPnl: 0, cost: 1 }),
    ])
    expect(s.realized).toBe(1)
    expect(s.wins).toBe(1)
    expect(s.losses).toBe(1)
    expect(s.winRate).toBe(0.5)
    expect(s.best?.asset).toBe('1')
    expect(s.worst?.asset).toBe('2')
    expect(s.invested).toBe(10)
  })
  it('has no win rate or extremes without decided calls', () => {
    const s = summarize([call({ realizedPnl: 0 })])
    expect(s.winRate).toBeNull()
    expect(s.best).toBeNull()
    expect(s.worst).toBeNull()
  })
})

describe('cumulative', () => {
  it('runs in time order', () => {
    expect(cumulative([call({ closedAt: 3, realizedPnl: -1 }), call({ closedAt: 1, realizedPnl: 2 })])).toEqual([
      { t: 1, pnl: 2 },
      { t: 3, pnl: 1 },
    ])
  })
})
