import { beforeEach, describe, expect, it } from 'vitest'
import { _resetAlerts, addAlert, alertsFor, checkAlerts, formatCents, getAlerts, MAX_FIRED_ALERTS, pruneAlerts, removeAlert, shouldFire, type PriceAlert } from './alerts'
import { _resetNotifications, getNotifications } from './notifications'
import { parseEndDate, positionEvents, type WatchedPosition } from './watchers'

const base = { tokenId: 't1', slug: 'fed-cut', title: 'Fed cuts in December?', outcome: 'Yes' }

describe('shouldFire', () => {
  it('fires above at or over the target', () => {
    expect(shouldFire({ op: 'above', price: 0.7 }, 0.69)).toBe(false)
    expect(shouldFire({ op: 'above', price: 0.7 }, 0.7)).toBe(true)
    expect(shouldFire({ op: 'above', price: 0.7 }, 0.1 * 7)).toBe(true)
  })
  it('fires below at or under the target', () => {
    expect(shouldFire({ op: 'below', price: 0.3 }, 0.31)).toBe(false)
    expect(shouldFire({ op: 'below', price: 0.3 }, 0.3)).toBe(true)
  })
  it('never fires twice or on a missing price', () => {
    expect(shouldFire({ op: 'above', price: 0.5, firedAt: 1 }, 0.9)).toBe(false)
    expect(shouldFire({ op: 'above', price: 0.5 }, undefined)).toBe(false)
    expect(shouldFire({ op: 'above', price: 0.5 }, NaN)).toBe(false)
  })
})

describe('alerts store', () => {
  beforeEach(() => {
    _resetAlerts()
    _resetNotifications()
  })

  it('dedupes identical armed alerts and removes', () => {
    const a = addAlert({ ...base, op: 'above', price: 0.7 })
    addAlert({ ...base, op: 'above', price: 0.7 })
    addAlert({ ...base, op: 'below', price: 0.3 })
    expect(alertsFor('t1')).toHaveLength(2)
    removeAlert(a.id)
    expect(alertsFor('t1')).toHaveLength(1)
  })

  it('fires one-shot notifications from fetched prices', async () => {
    addAlert({ ...base, op: 'above', price: 0.7 })
    addAlert({ ...base, op: 'below', price: 0.3 })
    addAlert({ ...base, tokenId: 't2', op: 'above', price: 0.5 })
    const fired = await checkAlerts(async () => ({ t1: 0.72 }))
    expect(fired).toHaveLength(1)
    expect(getNotifications()[0]).toMatchObject({ kind: 'alert', title: 'Yes hit 72¢', href: '#/market/fed-cut' })
    expect(await checkAlerts(async () => ({ t1: 0.8 }))).toHaveLength(0)
    expect(getAlerts().filter((a) => !a.firedAt)).toHaveLength(2)
  })

  it('caps the fired history', () => {
    const fired: PriceAlert[] = Array.from({ length: MAX_FIRED_ALERTS + 5 }, (_, i) => ({ ...base, id: `f${i}`, op: 'above', price: 0.5, createdAt: 0, firedAt: i + 1 }))
    const pruned = pruneAlerts([...fired, { ...base, id: 'live', op: 'below', price: 0.2, createdAt: 0 }])
    expect(pruned).toHaveLength(MAX_FIRED_ALERTS + 1)
    expect(pruned.some((a) => a.id === 'f0')).toBe(false)
  })

  it('formats cents', () => {
    expect(formatCents(0.7)).toBe('70¢')
    expect(formatCents(0.705)).toBe('70.5¢')
  })
})

describe('positionEvents', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  const p = (o: Partial<WatchedPosition>): WatchedPosition => ({
    asset: 'a1', conditionId: 'c1', title: 'Team A vs Team B', outcome: 'Team A', size: 10, currentValue: 10, redeemable: false, ...o,
  })

  it('celebrates winning redeemables once, ignores losses', () => {
    const ev = positionEvents([p({ redeemable: true }), p({ asset: 'a2', redeemable: true, currentValue: 0 })], new Set(), now)
    expect(ev.map((e) => e.key)).toEqual(['win:a1'])
    expect(ev[0].n.kind).toBe('win')
    expect(positionEvents([p({ redeemable: true })], new Set(['win:a1']), now)).toHaveLength(0)
  })

  it('warns once per market ending within 24h', () => {
    const ev = positionEvents(
      [p({ endDate: '2026-10-06', eventSlug: 'a-vs-b' }), p({ asset: 'a2', endDate: '2026-10-06' }), p({ asset: 'a3', conditionId: 'c3', endDate: '2026-10-09' })],
      new Set(),
      now,
    )
    expect(ev.map((e) => e.key)).toEqual(['ending:c1'])
    expect(ev[0].n.href).toBe('#/market/a-vs-b')
  })

  it('skips recurring up-or-down rounds and past dates', () => {
    expect(positionEvents([p({ title: 'Bitcoin Up or Down - 5m', endDate: '2026-10-06' })], new Set(), now)).toHaveLength(0)
    expect(positionEvents([p({ endDate: '2026-10-05' })], new Set(), now)).toHaveLength(0)
  })

  it('parses date-only end dates as the end of the UTC day', () => {
    expect(parseEndDate('2026-10-06')).toBe(Date.parse('2026-10-06T23:59:59Z'))
    expect(parseEndDate('2026-10-06T15:00:00Z')).toBe(Date.parse('2026-10-06T15:00:00Z'))
    expect(parseEndDate('nope')).toBeNull()
  })
})
