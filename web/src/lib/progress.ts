import { useSyncExternalStore } from 'react'
import { store } from '../config'
import { CHAPTERS, LEVELS, QUESTS, TOTAL_XP, type Chapter, type Quest } from './quests'
import { toast } from './toast'

// Quest progress, per wallet, entirely in this browser. Before a wallet connects, events land in
// an "anon" bucket that is folded into the wallet's bucket on connect.

export type ProgressEvent =
  | 'wallet_connected'
  | 'account_linked'
  | 'deposit_done'
  | 'trade_done'
  | 'multi_trade_done'
  | 'sell_done'
  | 'withdraw_done'
  | 'claim_done'
  | 'market_viewed'
  | 'chart_range_changed'
  | 'chart_candles'
  | 'book_viewed'
  | 'alert_set'
  | 'watch_added'
  | 'docs_read'
  | 'theme_switched'
  | 'share_copied'
  | 'search_used'
  | 'category_viewed'

export type ProgressMeta = { slug?: string; category?: string; page?: string }

export type ProgressData = {
  counts: Partial<Record<ProgressEvent, number>>
  sets: { marketsViewed: string[]; categories: string[]; docsRead: string[]; daysActive: string[] }
  completed: Record<string, number>
  /** Last time the quests page was opened; completions after it are "new". */
  seenAt?: number
}

const CAPS = { marketsViewed: 100, categories: 50, docsRead: 50, daysActive: 90 }

export const emptyProgress = (): ProgressData => ({
  counts: {},
  sets: { marketsViewed: [], categories: [], docsRead: [], daysActive: [] },
  completed: {},
})

/** Accepts whatever came out of storage and returns a well-formed record. */
export function normalize(raw: unknown): ProgressData {
  const out = emptyProgress()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Partial<ProgressData>
  if (r.counts && typeof r.counts === 'object') {
    for (const [k, v] of Object.entries(r.counts)) if (typeof v === 'number' && v > 0) out.counts[k as ProgressEvent] = Math.floor(v)
  }
  const sets = (r.sets ?? {}) as Partial<ProgressData['sets']>
  for (const k of Object.keys(out.sets) as (keyof ProgressData['sets'])[]) {
    const v = sets[k]
    if (Array.isArray(v)) out.sets[k] = v.filter((x): x is string => typeof x === 'string').slice(-CAPS[k])
  }
  if (r.completed && typeof r.completed === 'object') {
    for (const [k, v] of Object.entries(r.completed)) if (typeof v === 'number') out.completed[k] = v
  }
  if (typeof r.seenAt === 'number') out.seenAt = r.seenAt
  return out
}

// ---------- dates & streaks ----------

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const dayNum = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000)
}

export type Streak = { current: number; best: number; activeDays: number; activeToday: boolean }

/** Consecutive active days ending today (or yesterday, so the streak survives until you show up). */
export function computeStreak(days: string[], today: string): Streak {
  const nums = [...new Set(days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map(dayNum))].sort((a, b) => a - b)
  const set = new Set(nums)
  const t = dayNum(today)
  const activeToday = set.has(t)
  let current = 0
  for (let d = activeToday ? t : t - 1; set.has(d); d--) current++
  let best = 0
  let run = 0
  nums.forEach((n, i) => {
    run = i > 0 && n === nums[i - 1] + 1 ? run + 1 : 1
    best = Math.max(best, run)
  })
  return { current, best, activeDays: nums.length, activeToday }
}

// ---------- levels ----------

export type Level = { index: number; name: string; min: number; next: number | null; nextName: string | null; progress: number }

export function levelFor(xp: number): Level {
  let index = 0
  LEVELS.forEach((l, i) => {
    if (xp >= l.min) index = i
  })
  const cur = LEVELS[index]
  const nxt = LEVELS[index + 1]
  const progress = nxt ? Math.min(1, (xp - cur.min) / (nxt.min - cur.min)) : 1
  return { index, name: cur.name, min: cur.min, next: nxt ? nxt.min : null, nextName: nxt ? nxt.name : null, progress }
}

// ---------- pure updates ----------

const addToSet = (list: string[], value: string, cap: number) => [...list.filter((x) => x !== value), value].slice(-cap)

/** Records one event (pure). */
export function applyEvent(data: ProgressData, event: ProgressEvent, meta: ProgressMeta | undefined, now: number): ProgressData {
  const counts = { ...data.counts, [event]: (data.counts[event] ?? 0) + 1 }
  const sets = { ...data.sets, daysActive: addToSet(data.sets.daysActive, dayKey(now), CAPS.daysActive).sort() }
  const slug = meta?.slug?.trim()
  const category = meta?.category?.trim().toLowerCase()
  const page = meta?.page?.trim()
  if (event === 'market_viewed' && slug) sets.marketsViewed = addToSet(sets.marketsViewed, slug, CAPS.marketsViewed)
  if (event === 'category_viewed' && category) sets.categories = addToSet(sets.categories, category, CAPS.categories)
  if (event === 'docs_read' && page) sets.docsRead = addToSet(sets.docsRead, page, CAPS.docsRead)
  return { ...data, counts, sets }
}

/** Raises counts to at least the given values; never lowers them (pure). */
export function applyBackfill(data: ProgressData, counts: Partial<Record<ProgressEvent, number>>): ProgressData {
  const next = { ...data.counts }
  for (const [k, v] of Object.entries(counts) as [ProgressEvent, number | undefined][]) {
    if (typeof v === 'number' && Number.isFinite(v) && v > (next[k] ?? 0)) next[k] = Math.floor(v)
  }
  return { ...data, counts: next }
}

/** Folds anon progress into a wallet's: counts add up, sets union, earliest completion wins (pure). */
export function mergeProgress(into: ProgressData, from: ProgressData): ProgressData {
  const counts = { ...into.counts }
  for (const [k, v] of Object.entries(from.counts) as [ProgressEvent, number][]) counts[k] = (counts[k] ?? 0) + v
  const union = (a: string[], b: string[], cap: number) => [...new Set([...a, ...b])].slice(-cap)
  const completed = { ...into.completed }
  for (const [k, v] of Object.entries(from.completed)) completed[k] = Math.min(completed[k] ?? Infinity, v)
  return {
    counts,
    sets: {
      marketsViewed: union(into.sets.marketsViewed, from.sets.marketsViewed, CAPS.marketsViewed),
      categories: union(into.sets.categories, from.sets.categories, CAPS.categories),
      docsRead: union(into.sets.docsRead, from.sets.docsRead, CAPS.docsRead),
      daysActive: union(into.sets.daysActive, from.sets.daysActive, 1000).sort().slice(-CAPS.daysActive),
    },
    completed,
    seenAt: into.seenAt,
  }
}

const isEmpty = (d: ProgressData) =>
  Object.keys(d.counts).length === 0 && Object.keys(d.completed).length === 0 && Object.values(d.sets).every((s) => s.length === 0)

export function questProgress(q: Quest, data: ProgressData): number {
  const m = q.measure
  const raw =
    m.kind === 'count' ? (data.counts[m.event] ?? 0) : m.kind === 'distinct' ? data.sets[m.set].length : m.pages.filter((p) => data.sets.docsRead.includes(p)).length
  return Math.min(q.goal, raw)
}

/** Marks quests that reached their goal as completed; completions are sticky (pure). */
export function evaluate(data: ProgressData, now: number): { data: ProgressData; newly: Quest[] } {
  const newly = QUESTS.filter((q) => data.completed[q.id] === undefined && questProgress(q, data) >= q.goal)
  if (newly.length === 0) return { data, newly }
  const completed = { ...data.completed }
  for (const q of newly) completed[q.id] = now
  return { data: { ...data, completed }, newly }
}

// ---------- view ----------

export type QuestState = { quest: Quest; progress: number; goal: number; done: boolean; completedAt?: number; isNew: boolean }
export type ChapterState = { chapter: Chapter; quests: QuestState[]; done: number; total: number; xp: number; complete: boolean; completedAt?: number }
export type ProgressView = {
  account?: string
  xp: number
  totalXp: number
  level: Level
  quests: QuestState[]
  chapters: ChapterState[]
  badges: { chapter: Chapter; unlocked: boolean; unlockedAt?: number }[]
  streak: Streak
  recent: { quest: Quest; at: number }[]
  doneCount: number
  totalCount: number
  /** First unfinished quest, in chapter order. */
  next: QuestState | null
  newCount: number
}

export function buildView(data: ProgressData, now: number, account?: string): ProgressView {
  const seen = data.seenAt ?? 0
  const quests: QuestState[] = QUESTS.map((q) => {
    const at = data.completed[q.id]
    const done = at !== undefined
    return { quest: q, progress: done ? q.goal : questProgress(q, data), goal: q.goal, done, completedAt: at, isNew: done && at > seen }
  })
  const chapters: ChapterState[] = CHAPTERS.map((c) => {
    const qs = quests.filter((s) => s.quest.chapter === c.id)
    const done = qs.filter((s) => s.done).length
    const complete = qs.length > 0 && done === qs.length
    return {
      chapter: c,
      quests: qs,
      done,
      total: qs.length,
      xp: qs.reduce((s, x) => s + x.quest.xp, 0),
      complete,
      completedAt: complete ? Math.max(...qs.map((s) => s.completedAt ?? 0)) : undefined,
    }
  })
  const xp = quests.reduce((s, x) => s + (x.done ? x.quest.xp : 0), 0)
  return {
    account,
    xp,
    totalXp: TOTAL_XP,
    level: levelFor(xp),
    quests,
    chapters,
    badges: chapters.map((c) => ({ chapter: c.chapter, unlocked: c.complete, unlockedAt: c.completedAt })),
    streak: computeStreak(data.sets.daysActive, dayKey(now)),
    recent: quests
      .filter((s) => s.done)
      .map((s) => ({ quest: s.quest, at: s.completedAt! }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 5),
    doneCount: quests.filter((s) => s.done).length,
    totalCount: quests.length,
    next: quests.find((s) => !s.done) ?? null,
    newCount: quests.filter((s) => s.isNew).length,
  }
}

// ---------- live store ----------

const keyFor = (account?: string) => `yaynay:progress:${account ?? 'anon'}`

let account: string | undefined
// Evaluated on load too, so quests added later that are already satisfied complete right away.
let data: ProgressData = evaluate(normalize(store.get(keyFor())), Date.now()).data
let view: ProgressView | null = null
const listeners = new Set<() => void>()

function announce(newly: Quest[]) {
  if (newly.length === 0) return
  const xp = newly.reduce((s, q) => s + q.xp, 0)
  // A backfill can finish several at once; one toast beats a stack of them.
  if (newly.length > 2) toast({ kind: 'success', title: `${newly.length} quests complete`, detail: `+${xp} XP` })
  else for (const q of newly) toast({ kind: 'success', title: `Quest complete · ${q.name}`, detail: `+${q.xp} XP` })
}

function commit(next: ProgressData, opts: { quiet?: boolean } = {}) {
  const res = evaluate(next, Date.now())
  data = res.data
  store.set(keyFor(account), data)
  view = null
  listeners.forEach((l) => l())
  if (!opts.quiet) announce(res.newly)
}

export function track(event: ProgressEvent, meta?: ProgressMeta): void {
  commit(applyEvent(data, event, meta, Date.now()))
}

/** Switches the active bucket. On connect, anything done while anonymous moves to the wallet. */
export function setProgressAccount(address: string | undefined): void {
  const next = address ? address.toLowerCase() : undefined
  if (next === account) return
  account = next
  let d = normalize(store.get(keyFor(next)))
  if (next) {
    const anon = normalize(store.get(keyFor()))
    if (!isEmpty(anon)) {
      d = mergeProgress(d, anon)
      store.set(keyFor(), null)
    }
    // Being here means a wallet is connected, whether or not the caller tracked it.
    d = applyBackfill(d, { wallet_connected: 1 })
  }
  commit(d)
}

/** Raises counts from on-chain history (deposits, trades, ...). Never lowers anything. */
export function backfill(counts: Partial<Record<ProgressEvent, number>>): void {
  commit(applyBackfill(data, counts))
}

/** Marks current completions as seen (the quests page calls this after celebrating). */
export function markQuestsSeen(): void {
  commit({ ...data, seenAt: Date.now() }, { quiet: true })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function snapshot(): ProgressView {
  if (!view) view = buildView(data, Date.now(), account)
  return view
}

export function useProgress(): ProgressView {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

// Another tab made progress on the same bucket: pick it up.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== keyFor(account)) return
    data = normalize(store.get(keyFor(account)))
    view = null
    listeners.forEach((l) => l())
  })
}
