import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CATEGORIES, PAGE_SIZE, SORTS, fetchEventsBySlugs, listEventsPage, searchEventsPage, type PmEvent, type SortKey } from '../lib/markets'
import { Pagination } from './Pagination'
import { getWatchlist, useWatchlist } from '../lib/watchlist'
import { RECURRING_ROUND_RE } from '../config'
import { EventCard } from './EventCard'
import { Featured } from './Featured'
import { openPick } from '../lib/pick'
import { track } from '../lib/progress'

/** A genuinely open yes/no price: neither side is close to decided. */
const contested = (p: number) => p > 0.08 && p < 0.92

/**
 * The busiest open markets for the hero carousel. Multi-outcome events contribute their most likely
 * contested outcome as a yes/no market ("Fed decision: No change").
 */
function pickFeatured(events: PmEvent[], count = 6): PmEvent[] {
  const picks: PmEvent[] = []
  for (const e of events) {
    if (picks.length >= count) break
    if (RECURRING_ROUND_RE.test(e.title)) continue
    if (e.markets.length === 1) {
      if (contested(e.markets[0].outcomes[0].price)) picks.push(e)
      continue
    }
    const top = e.markets
      .filter((m) => contested(m.outcomes[0].price))
      .sort((a, b) => b.outcomes[0].price - a.outcomes[0].price)[0]
    if (top) picks.push({ ...e, title: `${e.title} · ${top.label}`, markets: [top] })
  }
  return picks
}

// A pseudo-category for markets the user starred.
const WATCHLIST = '__watchlist'

export function Markets(props: {
  /** Left side of the hero row; the featured market fills the right side. */
  hero?: ReactNode
  /** A slim row under the hero (the next quest). */
  belowHero?: ReactNode
}) {
  const [events, setEvents] = useState<PmEvent[]>([])
  const [featured, setFeatured] = useState<PmEvent[]>([])
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState<SortKey>('trending')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  const listTop = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const watchlist = useWatchlist()
  // What the list on screen was loaded with; paging and Retry use this, not the live search box.
  const [shown, setShown] = useState<{ category: string; sort: SortKey; query: string }>({ category: '', sort: 'trending', query: '' })

  // "/" focuses search, like most trading apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      // Not while a market page covers the (hidden) list.
      if (!searchInput.current?.offsetParent) return
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault()
        searchInput.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  async function load(next: { category: string; sort: SortKey; query?: string; page?: number }) {
    const id = ++request.current
    const pageNo = next.page ?? 0
    const q = (next.query ?? '').trim()
    setLoading(true)
    setError('')
    setPage(pageNo)
    setShown({ category: next.category, sort: next.sort, query: q })
    try {
      const result = q
        ? await searchEventsPage(q, pageNo)
        : next.category === WATCHLIST
          ? await fetchEventsBySlugs(getWatchlist().map((w) => w.slug)).then((events) => ({ events, total: events.length }))
          : await listEventsPage(next.category, next.sort, pageNo)
      if (id !== request.current) return
      setEvents(result.events)
      setTotal(result.total)
      // Keep the hero stable: set it from the first unfiltered trending load only.
      if (!q && !next.category && next.sort === 'trending' && pageNo === 0) {
        setFeatured((f) => (f.length ? f : pickFeatured(result.events)))
      }
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }

  const onWatchlist = shown.category === WATCHLIST && !shown.query
  const pages = onWatchlist ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE))
  const goToPage = (n: number) => {
    load({ ...shown, page: n })
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  useEffect(() => {
    load({ category: '', sort: 'trending' })
  }, [])

  // Starring or unstarring while the watchlist is open refreshes it.
  useEffect(() => {
    if (onWatchlist) load(shown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist.length])

  return (
    <>
      {props.hero && (
        <div className="hero-grid">
          {props.hero}
          {featured.length > 0 ? (
            <Featured events={featured} onPick={openPick} />
          ) : (
            <div className="skeleton" style={{ height: 'auto', minHeight: 380 }} />
          )}
        </div>
      )}
      {props.belowHero}

      <div className="section-head" ref={listTop}>
        <div>
          <h1>Markets</h1>
          <p className="section-sub">Pick a side on anything. Prices are the crowd's odds: 62¢ ≈ 62% chance.</p>
        </div>
      </div>
      <div className="toolbar">
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault()
            if (query.trim()) track('search_used')
            setCategory('')
            load({ category: '', sort, query })
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={searchInput}
            placeholder="Search any market…  ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search markets"
          />
        </form>
        <div className="chips">
          {CATEGORIES.map((c) => (
            <button
              key={c.slug}
              className={`chip${!shown.query && shown.category === c.slug ? ' active' : ''}`}
              aria-pressed={!shown.query && shown.category === c.slug}
              onClick={() => {
                setQuery('')
                setCategory(c.slug)
                if (c.slug) track('category_viewed', { category: c.slug })
                load({ category: c.slug, sort })
              }}
            >
              {c.label}
            </button>
          ))}
          {watchlist.length > 0 && (
            <button
              className={`chip watch-chip${onWatchlist ? ' active' : ''}`}
              aria-pressed={onWatchlist}
              onClick={() => {
                setQuery('')
                setCategory(WATCHLIST)
                load({ category: WATCHLIST, sort })
              }}
            >
              ★ Watchlist <span className="chip-count">{watchlist.length}</span>
            </button>
          )}
        </div>
        <label className="sort">
          <select
            value={sort}
            aria-label="Sort markets"
            onChange={(e) => {
              const next = e.target.value as SortKey
              setSort(next)
              setQuery('')
              load({ category, sort: next })
            }}
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                Sort: {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="banner danger">
          <span className="grow">Markets could not load: {error}</span>
          <button className="ghost" onClick={() => load({ ...shown, page })}>
            Retry
          </button>
        </div>
      )}

      <div className="grid">
        {loading
          ? Array.from({ length: 9 }, (_, i) => <div key={i} className="skeleton" />)
          : events.map((ev) => <EventCard key={ev.id} event={ev} onPick={openPick} />)}
      </div>
      {!loading && !error && events.length === 0 && (
        <div className="empty">
          {onWatchlist
            ? 'No open starred markets. Tap ☆ on any market to keep it here.'
            : 'No open markets found.'}
        </div>
      )}
      {!error && pages > 1 && <Pagination page={page} pages={pages} disabled={loading} onPage={goToPage} />}
      <p className="muted" style={{ marginTop: 14 }}>
        Effectively decided markets (one side above 97¢) are hidden to keep you out of near-certain traps.
      </p>

    </>
  )
}
