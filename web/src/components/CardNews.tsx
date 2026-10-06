import { useEffect, useState } from 'react'
import { fetchChartHistory, type PricePoint } from '../lib/chart'
import { timeAgo } from '../lib/dashboard'
import type { PmEvent } from '../lib/markets'
import { faviconUrl, relevant, fetchNews, monogram, moveSince, newsQuery, type NewsItem } from '../lib/news'
import '../styles/news.css'

const MAX_STORIES = 4
/** Each story takes this long to scroll past. */
const SECONDS_PER_STORY = 5

/** The token whose odds the card leads with: Yes of a single market, else the favourite outcome. */
function leadToken(event: PmEvent): { tokenId: string; label: string } | null {
  const priced = event.markets.filter((m) => m.outcomes[0])
  if (priced.length === 0) return null
  const m = priced.length === 1 ? priced[0] : priced.reduce((a, b) => (b.outcomes[0].price > a.outcomes[0].price ? b : a))
  return { tokenId: m.outcomes[0].tokenId, label: priced.length === 1 ? m.outcomes[0].name : m.label }
}

function Favicon({ item }: { item: NewsItem }) {
  const [broken, setBroken] = useState(false)
  const src = faviconUrl(item)
  if (!src || broken) {
    return (
      <span className="cn-fav mono-fav" aria-hidden="true">
        {monogram(item.source)}
      </span>
    )
  }
  return <img className="cn-fav" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
}

/** Rounded points with a sign: +4, −2, 0. */
const pts = (d: number) => {
  const n = Math.round(d * 100)
  return n === 0 ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`
}

/**
 * Headlines inside a market card, flowing upward on their own. Each story carries how far the card's
 * leading odds moved since it was published, so you can see which news the market reacted to.
 */
export function CardNews({ event }: { event: PmEvent }) {
  const [items, setItems] = useState<NewsItem[] | null>(null)
  const [history, setHistory] = useState<PricePoint[]>([])
  const lead = leadToken(event)
  const query = newsQuery(event.title)

  useEffect(() => {
    if (query.length < 2) return
    const ctl = new AbortController()
    fetchNews(query, ctl.signal)
      .then((r) => setItems(relevant(r.items, query).slice(0, MAX_STORIES)))
      .catch(() => !ctl.signal.aborted && setItems([]))
    return () => ctl.abort()
  }, [query])

  const leadId = lead?.tokenId
  useEffect(() => {
    if (!leadId) return
    const ctl = new AbortController()
    fetchChartHistory(leadId, '1W', { signal: ctl.signal })
      .then(setHistory)
      .catch(() => undefined)
    return () => ctl.abort()
  }, [leadId])

  if (!items || items.length === 0) return null

  const loop = items.length > 1
  const row = (i: NewsItem, copy: number) => {
    const move = moveSince(history, i.publishedAt)
    const shown = move !== null && Math.abs(move) >= 0.005
    return (
      <li key={`${copy}-${i.url}`} aria-hidden={copy > 0 || undefined}>
        <a href={i.url} target="_blank" rel="noopener noreferrer" tabIndex={copy > 0 ? -1 : undefined}>
          <span className="cn-meta">
            <Favicon item={i} />
            <b>{i.source}</b>
            <span>· {timeAgo(i.publishedAt)}</span>
            {shown && lead && (
              <span
                className={`cn-move ${move > 0 ? 'up' : 'down'}`}
                title={`${lead.label} ${move > 0 ? 'up' : 'down'} ${Math.abs(Math.round(move * 100))} pts since this story`}
              >
                {move > 0 ? '▲' : '▼'} {pts(move).replace(/^[+−]/, '')} pts
              </span>
            )}
          </span>
          <span className="cn-title">{i.title}</span>
        </a>
      </li>
    )
  }

  return (
    <div className="cn" aria-label={`News about ${event.title}`}>
      <ul className={`cn-feed${loop ? ' looping' : ''}`} style={{ animationDuration: `${items.length * SECONDS_PER_STORY}s` }}>
        {items.map((i) => row(i, 0))}
        {loop && items.map((i) => row(i, 1))}
      </ul>
    </div>
  )
}
