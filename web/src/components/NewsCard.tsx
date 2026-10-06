import { useCallback, useEffect, useState } from 'react'
import { timeAgo } from '../lib/dashboard'
import { fetchNews, relevant, monogram, NEWS_REFRESH_MS, newsQuery, type NewsItem } from '../lib/news'
import '../styles/news.css'

const TONES = ['mint', 'coral', 'ink', 'sun'] as const
const tone = (source: string) => TONES[[...source].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length]
const SHOWN = 6

function SourceMark({ source }: { source: string }) {
  return (
    <span className={`nw-mark t-${tone(source)}`} aria-hidden="true">
      {monogram(source)}
    </span>
  )
}

/**
 * Recent headlines about an event, refreshed every few minutes while the page is visible.
 * Stories that arrive after the page opened are marked "New".
 */
export function NewsCard({ title }: { title: string }) {
  const query = newsQuery(title)
  const [items, setItems] = useState<NewsItem[] | null>(null)
  const [error, setError] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [provider, setProvider] = useState('google')
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [, tick] = useState(0)
  // URLs seen in the first load; anything outside it is new since the page opened.
  const [firstSeen, setFirstSeen] = useState<Set<string> | null>(null)

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (query.length < 2) return
      setLoading(true)
      fetchNews(query, signal)
        .then((r) => {
          setFirstSeen((seen) => seen ?? new Set(r.items.map((i) => i.url)))
          // Prefer stories that name the market; fall back to the whole search if none do.
          const onTopic = relevant(r.items, query)
          setItems(onTopic.length ? onTopic : r.items)
          setFetchedAt(Date.now() / 1000)
          setProvider(r.provider)
          setError(false)
        })
        .catch((e) => {
          if (e instanceof DOMException && e.name === 'AbortError') return
          setError(true)
          setItems((prev) => prev ?? [])
        })
        .finally(() => setLoading(false))
    },
    [query],
  )

  useEffect(() => {
    const ctl = new AbortController()
    load(ctl.signal)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load()
      else tick((n) => n + 1)
    }, NEWS_REFRESH_MS)
    const onVisible = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onVisible)
    // Keeps the "updated … ago" and story ages current between refreshes.
    const clock = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => {
      ctl.abort()
      window.clearInterval(timer)
      window.clearInterval(clock)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  if (query.length < 2) return null

  const isNew = (i: NewsItem) => !!firstSeen && !firstSeen.has(i.url)
  const [lead, ...rest] = items ?? []
  const list = expanded ? rest : rest.slice(0, SHOWN - 1)

  return (
    <section className="card nw" aria-labelledby="nw-h">
      <div className="nw-head">
        <div>
          <span className="eyebrow nw-live">
            <span className="live-dot" aria-hidden="true" /> Live coverage
          </span>
          <h2 id="nw-h">In the news</h2>
          <p className="nw-sub">
            Latest reporting on <q>{query}</q>
          </p>
        </div>
        <button
          type="button"
          className={`subtle nw-refresh${loading ? ' spinning' : ''}`}
          onClick={() => load()}
          disabled={loading}
          title="Refresh headlines"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          {fetchedAt ? `Updated ${timeAgo(fetchedAt)}` : 'Loading'}
        </button>
      </div>

      {items === null ? (
        <div className="nw-skel" aria-label="Loading headlines">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : items.length === 0 ? (
        <p className="nw-empty">{error ? 'Headlines are unavailable right now. Try again in a minute.' : 'No reporting on this in the past week.'}</p>
      ) : (
        <>
          <a className="nw-lead" href={lead.url} target="_blank" rel="noopener noreferrer">
            <span className="nw-lead-meta">
              <SourceMark source={lead.source} />
              <b>{lead.source}</b>
              <span>{timeAgo(lead.publishedAt)}</span>
              {isNew(lead) && <span className="nw-new">New</span>}
            </span>
            <span className="nw-lead-title">{lead.title}</span>
            <span className="nw-read">
              Read on {lead.source} <span aria-hidden="true">↗</span>
            </span>
          </a>

          {list.length > 0 && (
            <ol className="nw-list">
              {list.map((i) => (
                <li key={i.url} className={isNew(i) ? 'fresh' : undefined}>
                  <a href={i.url} target="_blank" rel="noopener noreferrer">
                    <SourceMark source={i.source} />
                    <span className="nw-item">
                      <span className="nw-title">{i.title}</span>
                      <span className="nw-meta">
                        <b>{i.source}</b>
                        <span aria-hidden="true">·</span>
                        <time dateTime={new Date(i.publishedAt * 1000).toISOString()}>{timeAgo(i.publishedAt)}</time>
                        {isNew(i) && <span className="nw-new">New</span>}
                      </span>
                    </span>
                    <span className="nw-go" aria-hidden="true">
                      ↗
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}

          {rest.length > SHOWN - 1 && (
            <button type="button" className="link nw-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show fewer' : `Show ${rest.length - (SHOWN - 1)} more`}
            </button>
          )}
          <p className="nw-note">Headlines from {provider === 'bing' ? 'Bing News' : 'Google News'}, newest first. Links open the publisher's site; YayNay doesn't write or check them.</p>
        </>
      )}
    </section>
  )
}
