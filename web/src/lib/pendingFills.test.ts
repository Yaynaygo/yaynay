import { afterEach, describe, expect, it } from 'vitest'
import { addPendingFill, isSettled, peekFills, resetPendingFills, setBaseSizes, settleFills, PENDING_TTL_MS } from './pendingFills'

const fill = { asset: 't1', conditionId: 'c', outcome: 'Yes', title: 'm', shares: 4.1, cost: 3.15, at: 1_000 }

afterEach(resetPendingFills)

describe('pending fills', () => {
  it('settles once the position grows by the bought shares', () => {
    const f = { ...fill, baseSize: 7.72 }
    expect(isSettled(f, 7.72, 2_000)).toBe(false)
    expect(isSettled(f, 11.82, 2_000)).toBe(true)
  })
  it('waits for a base size before settling on size', () => {
    expect(isSettled({ ...fill }, 50, 2_000)).toBe(false)
  })
  it('expires after the TTL', () => {
    expect(isSettled({ ...fill, baseSize: 0 }, 0, fill.at + PENDING_TTL_MS + 1)).toBe(true)
  })
  it('records base sizes once and drops settled fills', () => {
    addPendingFill(fill)
    setBaseSizes(() => 0)
    setBaseSizes(() => 99) // already recorded: ignored
    expect(peekFills()[0].baseSize).toBe(0)
    settleFills(() => 0, 2_000)
    expect(peekFills()).toHaveLength(1)
    settleFills(() => 4.1, 2_000)
    expect(peekFills()).toHaveLength(0)
  })
})
