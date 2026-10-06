import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBackfill,
  applyEvent,
  buildView,
  computeStreak,
  dayKey,
  emptyProgress,
  evaluate,
  levelFor,
  mergeProgress,
  normalize,
} from './progress'
import { LEVELS, QUESTS, TOTAL_XP } from './quests'

const toastSpy = vi.fn()
vi.mock('./toast', () => ({ toast: (t: unknown) => toastSpy(t) }))

const NOW = new Date(2026, 9, 6, 12).getTime()

describe('levels', () => {
  it('maps XP to levels and progress toward the next one', () => {
    expect(levelFor(0)).toMatchObject({ index: 0, name: 'Rookie', next: 100, progress: 0 })
    expect(levelFor(50).progress).toBeCloseTo(0.5)
    expect(levelFor(100)).toMatchObject({ index: 1, name: 'Caller', nextName: 'Analyst' })
    expect(levelFor(TOTAL_XP)).toMatchObject({ name: 'Oracle', next: null, progress: 1 })
  })

  it('keeps the top level reachable', () => {
    expect(LEVELS[LEVELS.length - 1].min).toBeLessThanOrEqual(TOTAL_XP)
    expect(new Set(QUESTS.map((q) => q.id)).size).toBe(QUESTS.length)
  })
})

describe('completion', () => {
  it('completes count, distinct and doc-page quests at their goal', () => {
    let d = emptyProgress()
    d = applyEvent(d, 'trade_done', undefined, NOW)
    for (const slug of ['a', 'b', 'b', 'c', 'd']) d = applyEvent(d, 'market_viewed', { slug }, NOW)
    d = applyEvent(d, 'docs_read', { page: 'fees' }, NOW)
    let res = evaluate(d, NOW)
    const ids = res.newly.map((q) => q.id)
    expect(ids).toContain('first-call')
    expect(ids).not.toContain('window-shopper') // 4 distinct, needs 5
    expect(ids).not.toContain('fine-print') // risks still unread

    d = applyEvent(applyEvent(res.data, 'market_viewed', { slug: 'e' }, NOW), 'docs_read', { page: 'risks' }, NOW)
    res = evaluate(d, NOW + 1)
    expect(res.newly.map((q) => q.id).sort()).toEqual(['fine-print', 'window-shopper'])
    expect(evaluate(res.data, NOW + 2).newly).toEqual([]) // only once

    const view = buildView(res.data, NOW)
    expect(view.xp).toBe(50 + 30 + 40)
    expect(view.next?.quest.id).toBe('read-the-route')
  })

  it('keeps completions sticky and unlocks a badge per finished chapter', () => {
    const d = emptyProgress()
    for (const q of QUESTS.filter((q) => q.chapter === 'explorer')) d.completed[q.id] = NOW
    const view = buildView(d, NOW)
    expect(view.badges.find((b) => b.chapter.id === 'explorer')?.unlocked).toBe(true)
    expect(view.badges.find((b) => b.chapter.id === 'rookie')?.unlocked).toBe(false)
    expect(view.newCount).toBe(5)
    expect(buildView({ ...d, seenAt: NOW }, NOW).newCount).toBe(0)
  })
})

describe('streak', () => {
  it('counts consecutive days ending today or yesterday', () => {
    expect(computeStreak(['2026-10-04', '2026-10-05', '2026-10-06'], '2026-10-06')).toMatchObject({ current: 3, activeToday: true })
    expect(computeStreak(['2026-10-04', '2026-10-05'], '2026-10-06')).toMatchObject({ current: 2, activeToday: false })
    expect(computeStreak(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05'], '2026-10-08')).toMatchObject({ current: 0, best: 3, activeDays: 4 })
    // Month and year boundaries.
    expect(computeStreak(['2025-12-31', '2026-01-01'], '2026-01-01').current).toBe(2)
    expect(computeStreak(['2026-09-30', '2026-10-01'], '2026-10-01').current).toBe(2)
  })

  it('records the local day on every event', () => {
    const d = applyEvent(emptyProgress(), 'search_used', undefined, NOW)
    expect(d.sets.daysActive).toEqual([dayKey(NOW)])
    expect(dayKey(NOW)).toBe('2026-10-06')
  })
})

describe('backfill and merge', () => {
  it('backfill raises counts but never lowers them', () => {
    let d = emptyProgress()
    d.counts.trade_done = 5
    d = applyBackfill(d, { trade_done: 2, deposit_done: 3, sell_done: -1, claim_done: NaN })
    expect(d.counts).toEqual({ trade_done: 5, deposit_done: 3 })
  })

  it('merges anon progress: counts add, sets union, earliest completion wins', () => {
    const wallet = emptyProgress()
    wallet.counts.market_viewed = 2
    wallet.sets.marketsViewed = ['a', 'b']
    wallet.completed['book-worm'] = 200
    const anon = emptyProgress()
    anon.counts.market_viewed = 1
    anon.sets.marketsViewed = ['b', 'c']
    anon.completed['book-worm'] = 100
    anon.completed.seeker = 150
    const m = mergeProgress(wallet, anon)
    expect(m.counts.market_viewed).toBe(3)
    expect(m.sets.marketsViewed).toEqual(['a', 'b', 'c'])
    expect(m.completed).toEqual({ 'book-worm': 100, seeker: 150 })
  })

  it('normalizes junk from storage', () => {
    expect(normalize('nope')).toEqual(emptyProgress())
    const n = normalize({ counts: { trade_done: 2, x: 'y' }, sets: { categories: ['sports', 3] }, completed: { a: 1, b: 'c' } })
    expect(n.counts).toEqual({ trade_done: 2 })
    expect(n.sets.categories).toEqual(['sports'])
    expect(n.completed).toEqual({ a: 1 })
  })

  it('caps the markets set at 100, keeping the most recent', () => {
    let d = emptyProgress()
    for (let i = 0; i < 120; i++) d = applyEvent(d, 'market_viewed', { slug: `m${i}` }, NOW)
    expect(d.sets.marketsViewed).toHaveLength(100)
    expect(d.sets.marketsViewed[99]).toBe('m119')
  })
})

describe('live store', () => {
  const mem = new Map<string, string>()
  beforeEach(() => {
    mem.clear()
    toastSpy.mockClear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    })
    vi.resetModules()
  })

  it('tracks anonymously, toasts once, and moves anon progress to the wallet on connect', async () => {
    const p = await import('./progress')
    p.track('search_used')
    p.track('search_used')
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy).toHaveBeenCalledWith({ kind: 'success', title: 'Quest complete · Seeker', detail: '+15 XP' })
    expect(JSON.parse(mem.get('yaynay:progress:anon')!).counts.search_used).toBe(2)

    p.setProgressAccount('0xABC')
    expect(mem.has('yaynay:progress:anon')).toBe(false)
    const saved = JSON.parse(mem.get('yaynay:progress:0xabc')!)
    expect(saved.counts.search_used).toBe(2)
    expect(saved.completed.seeker).toBeTypeOf('number')
    expect(saved.completed['connect-wallet']).toBeTypeOf('number')

    p.backfill({ deposit_done: 1, trade_done: 4 })
    p.backfill({ trade_done: 1 })
    expect(JSON.parse(mem.get('yaynay:progress:0xabc')!).counts.trade_done).toBe(4)

    // Disconnect: back to an empty anon bucket.
    p.setProgressAccount(undefined)
    p.track('book_viewed')
    expect(JSON.parse(mem.get('yaynay:progress:anon')!).counts).toEqual({ book_viewed: 1 })
  })

  it('collapses a big batch of completions into one toast', async () => {
    const p = await import('./progress')
    p.setProgressAccount('0x1')
    toastSpy.mockClear()
    p.backfill({ account_linked: 1, deposit_done: 1, trade_done: 1, withdraw_done: 1 })
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: '4 quests complete', detail: '+170 XP' })
  })
})
