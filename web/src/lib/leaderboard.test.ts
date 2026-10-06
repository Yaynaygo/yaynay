import { describe, expect, it } from 'vitest'
import { barShare, rankLabel, toLeader, type Leader } from './leaderboard'

const row = (over: Partial<Leader>): Leader => ({ rank: 1, wallet: '0x1', name: 'a', verified: false, pnl: 0, volume: 0, ...over })

describe('toLeader', () => {
  it('maps a v2 row and hides address-like usernames', () => {
    const l = toLeader({
      rank: 2,
      user_id: '0x2C335066FE58fe9237c3d3Dc7b275C2a034a0563',
      pnl: 40868.7,
      volume: 4936513.8,
      user_name: '0x2c335066FE58fe9237c3d3Dc7b275C2a034a0563-1759935795465',
      x_username: '@someone',
      verified: true,
    })
    expect(l).toMatchObject({ rank: 2, wallet: '0x2c335066fe58fe9237c3d3dc7b275c2a034a0563', x: 'someone', verified: true })
    expect(l.name).toBe('0x2C33…0563')
  })
  it('keeps chosen names', () => {
    expect(toLeader({ rank: 1, user_id: '0xabc', pnl: 1, volume: 2, user_name: 'mooseborzoii' }).name).toBe('mooseborzoii')
  })
})

describe('barShare', () => {
  it('scales against the leader by the sort key', () => {
    const top = row({ pnl: 200, volume: 1000 })
    expect(barShare(row({ pnl: 50 }), top, 'PNL')).toBe(0.25)
    expect(barShare(row({ volume: 500 }), top, 'VOLUME')).toBe(0.5)
    expect(barShare(row({ pnl: -400 }), top, 'PNL')).toBe(1)
    expect(barShare(row({ pnl: 5 }), undefined, 'PNL')).toBe(0)
  })
})

describe('rankLabel', () => {
  it('compacts large ranks', () => {
    expect(rankLabel(42)).toBe('#42')
    expect(rankLabel(48_200)).toBe('#48k')
    expect(rankLabel(1_099_210)).toBe('#1.1M')
  })
})
