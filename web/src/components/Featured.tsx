import { useState } from 'react'
import type { PmEvent } from '../lib/markets'
import type { Pick } from './EventCard'
import { Sparkline } from './Sparkline'
import { cents, endsLabel, multiplier } from './format'
import { routeHref } from '../lib/router'
import { displayPrice, useLivePrices } from '../lib/liveMarket'

/** Hero-side carousel of the most active two-outcome markets, each with its weekly chart. */
export function Featured({ events, onPick }: { events: PmEvent[]; onPick: (pick: Pick) => void }) {
  const [index, setIndex] = useState(0)
  const count = events.length
  const event = events[index % count]
  const market = event.markets[0]
  const [first, second] = market.outcomes
  // Live odds for the slide on screen only; the cards keep their own prices.
  const live = useLivePrices([first.tokenId, second.tokenId])
  const px = (tokenId: string, fallback: number) => displayPrice(live[tokenId]) ?? fallback
  const firstPx = px(first.tokenId, first.price)
  const secondPx = px(second.tokenId, second.price)
  const change = market.dayChange * 100
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count)

  return (
    <section
      className="card featured"
      aria-roledescription="carousel"
      aria-label="Featured markets"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') go(1)
        if (e.key === 'ArrowLeft') go(-1)
      }}
    >
      <div className="featured-top">
        <div className="eyebrow accent">
          <span className="live-dot" /> &nbsp;Featured market
        </div>
        {count > 1 && (
          <span className="mono muted carousel-count" aria-live="polite">
            {(index % count) + 1} / {count}
          </span>
        )}
      </div>

      <div className="featured-slide" key={event.id}>
        <div className="head">
          {event.image ? <img className="event-img" src={event.image} alt="" /> : <div className="event-img" />}
          <a className="title" href={routeHref({ name: 'market', slug: event.slug, marketId: market.id })}>
            {event.title}
          </a>
        </div>
        <div className="row">
          <div>
            <div className="big num">{Math.round(firstPx * 100)}%</div>
            <div className="muted">chance of {first.name}</div>
          </div>
          {Math.abs(change) >= 0.5 && (
            <span className={`change ${change > 0 ? 'up' : 'down'}`}>
              {change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)} pts 24h
            </span>
          )}
        </div>
        <Sparkline tokenId={first.tokenId} interval="1w" />
        <div className="big-pick">
          <button className="pick yes" onClick={() => onPick({ event, market, outcome: first })}>
            {first.name} {cents(firstPx)}
            <small>pays {multiplier(firstPx)}</small>
          </button>
          <button className="pick no" onClick={() => onPick({ event, market, outcome: second })}>
            {second.name} {cents(secondPx)}
            <small>pays {multiplier(secondPx)}</small>
          </button>
        </div>
        <div className="event-meta">
          <span>${Math.round(event.volume24hr).toLocaleString()} vol 24h</span>
          {market.endDate && <span>· {endsLabel(market.endDate)}</span>}
          <a className="featured-more" href={routeHref({ name: 'market', slug: event.slug, marketId: market.id })}>
            Chart, order book &amp; rules →
          </a>
        </div>
      </div>

      {count > 1 && (
        <>
          <button className="carousel-arrow prev" onClick={() => go(-1)} aria-label="Previous featured market">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <button className="carousel-arrow next" onClick={() => go(1)} aria-label="Next featured market">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </>
      )}

      {count > 1 && (
        <div className="dots" role="tablist" aria-label="Choose a featured market">
          {events.map((e, i) => (
            <button
              key={e.id}
              role="tab"
              aria-selected={i === index % count}
              aria-label={e.title}
              className={`dot-btn${i === index % count ? ' on' : ''}`}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
