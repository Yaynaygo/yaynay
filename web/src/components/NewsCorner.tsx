import { useEffect, useState } from 'react'
import { timeAgo } from '../lib/dashboard'
import type { PmEvent } from '../lib/markets'
import { fetchNews, relevant, monogram, NEWS_REFRESH_MS, newsQuery, pairHeadlines, type MarketHeadline } from '../lib/news'
import { routeHref } from '../lib/router'
import '../styles/news.css'

/** Scroll speed: each story takes this long to pass through. */
const SECONDS_PER_STORY = 6
const EVENTS = 5
const MIN_KEY = 'yaynay:news-corner'

/** The corner starts tucked into a pill so it never covers the hero; it opens only once the user asks for it. */
const readMin = () => {
  try {
    return localStorage.getItem(MIN_KEY) !== 'open'
  } catch {
    return true
  }
}
const writeMin = (min: boolean) => {
  try {
    localStorage.setItem(MIN_KEY, min ? 'min' : 'open')
  } catch {
    // Storage blocked: the corner starts tucked away next visit.
  }
}

/**
 * A corner card on the home page whose feed scrolls on its own through the latest headlines about today's
 * busiest markets, each paired with that market's leading odds. It keeps flowing on hover. It starts as a pill and remembers whether the user opened it.
 */
export function NewsCorner({ events }: { events: PmEvent[] }) {
  const [items, setItems] = useState<MarketHeadline[]>([])
  const [min, setMin] = useState(readMin)
  const slugs = events
    .slice(0, EVENTS)
    .map((e) => e.slug)
    .join(',')

  // Fetch headlines for the top events, and again every few minutes.
  useEffect(() => {
    const top = events.slice(0, EVENTS).filter((e) => newsQuery(e.title).length >= 2)
    if (top.length === 0) return
    let cancelled = false
    const load = () =>
      Promise.all(top.map((e) => fetchNews(newsQuery(e.title)).then((r) => ({ event: e, items: relevant(r.items, newsQuery(e.title)) }), () => ({ event: e, items: [] }))))
        .then((groups) => {
          if (cancelled) return
          const next = pairHeadlines(groups)
          if (next.length) setItems(next)
        })
    load()
    const timer = window.setInterval(() => document.visibilityState === 'visible' && load(), NEWS_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // Only the slugs matter: a refreshed list with the same events shouldn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugs])

  if (items.length === 0) return null

  const toggleMin = (v: boolean) => {
    setMin(v)
    writeMin(v)
  }

  if (min) {
    return (
      <button type="button" className="nc-pill" onClick={() => toggleMin(false)} aria-label="Show market news">
        <span className="live-dot" aria-hidden="true" />
        News
        <span className="nc-pill-count num">{items.length}</span>
      </button>
    )
  }

  // The list is drawn twice and scrolled by exactly one copy, so the feed loops without a seam.
  const loop = items.length > 2
  const story = (h: MarketHeadline, copy: number) => {
    const pct = h.odds ? Math.round(h.odds.chance * 100) : null
    return (
      <li key={`${copy}-${h.url}`} className="nc-item" aria-hidden={copy > 0 || undefined}>
        <a className="nc-story" href={h.url} target="_blank" rel="noopener noreferrer" tabIndex={copy > 0 ? -1 : undefined}>
          <span className="nc-src">
            <span className="nc-mark" aria-hidden="true">
              {monogram(h.source)}
            </span>
            <b>{h.source}</b>
            <span>· {timeAgo(h.publishedAt)}</span>
          </span>
          <span className="nc-title">{h.title}</span>
        </a>
        <a className="nc-market" href={routeHref({ name: 'market', slug: h.event.slug })} tabIndex={copy > 0 ? -1 : undefined}>
          {h.event.image ? <img src={h.event.image} alt="" loading="lazy" /> : <span className="nc-market-img" />}
          <span className="nc-market-title">{h.event.title}</span>
          {pct !== null && h.odds && (
            <span className={`nc-odds num ${pct >= 50 ? 'yay' : 'nay'}`}>
              <span className="nc-odds-label">{h.odds.label}</span> {pct}%
            </span>
          )}
        </a>
      </li>
    )
  }

  return (
    <aside className="nc" aria-label="Market news">
      <div className="nc-head">
        <span className="nc-live">
          <span className="live-dot" aria-hidden="true" /> News moving markets
        </span>
        <button type="button" className="nc-btn" onClick={() => toggleMin(true)} aria-label="Hide news">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8h9" />
          </svg>
        </button>
      </div>
      <div className="nc-viewport">
        <ul className={`nc-feed${loop ? ' looping' : ''}`} style={{ animationDuration: `${items.length * SECONDS_PER_STORY}s` }}>
          {items.map((h) => story(h, 0))}
          {loop && items.map((h) => story(h, 1))}
        </ul>
      </div>
    </aside>
  )
}
