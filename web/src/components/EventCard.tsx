import { useState } from 'react'
import type { Market, Outcome, PmEvent } from '../lib/markets'
import { routeHref } from '../lib/router'
import { CardNews } from './CardNews'
import { InView } from './InView'
import { WatchButton } from './WatchButton'
import { cents, endsLabel, multiplier, volume } from './format'

export type Pick = { event: PmEvent; market: Market; outcome: Outcome }

const pct = (p: number) => `${Math.round(p * 100)}%`

export function EventCard({ event, onPick }: { event: PmEvent; onPick: (pick: Pick) => void }) {
  const [expanded, setExpanded] = useState(false)
  const single = event.markets.length === 1 ? event.markets[0] : null
  // Multi-outcome events: most likely outcomes first.
  const ranked = [...event.markets].sort((a, b) => (b.outcomes[0]?.price ?? 0) - (a.outcomes[0]?.price ?? 0))
  const visible = expanded ? ranked : ranked.slice(0, 4)
  const end = single?.endDate ?? event.endDate

  return (
    <article className="card event-card">
      <div className="event-head">
        {event.image ? <img className="event-img" src={event.image} alt="" loading="lazy" /> : <div className="event-img" />}
        <div>
          {/* The title opens the market's own page; the stretched link makes the whole header clickable. */}
          <a className="event-title stretched" href={routeHref({ name: 'market', slug: event.slug })}>
            {event.title}
          </a>
          <div className="event-meta">
            <span>{volume(event.volume24hr)} vol</span>
            {end && <span>· {endsLabel(end)}</span>}
          </div>
        </div>
        <WatchButton compact slug={event.slug} title={event.title} image={event.image} />
      </div>

      {single ? (
        <>
          <div>
            <div className="prob">
              <span className="big num">{pct(single.outcomes[0].price)}</span>
              <span className="muted">chance · {single.outcomes[0].name}</span>
            </div>
            <div className="bar" style={{ marginTop: 10 }}>
              <span style={{ width: pct(single.outcomes[0].price) }} />
            </div>
          </div>
          <InView minHeight={0} margin="200px">
            <CardNews event={event} />
          </InView>
          <div className="pair">
            {single.outcomes.slice(0, 2).map((o, i) => (
              <button
                key={o.tokenId}
                className={`pick ${i === 0 ? 'yes' : 'no'}`}
                onClick={() => onPick({ event, market: single, outcome: o })}
                aria-label={`Buy ${o.name} at ${cents(o.price)}`}
              >
                {o.name} {cents(o.price)}
                <small>pays {multiplier(o.price)}</small>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="outcomes">
          {visible.map((m) => (
            <div className="outcome-row" key={m.id}>
              <span className="name" title={m.label}>
                {m.label}
              </span>
              <span className="pct num">{pct(m.outcomes[0].price)}</span>
              <span style={{ display: 'flex', gap: 4 }}>
                <button className="pick yes" onClick={() => onPick({ event, market: m, outcome: m.outcomes[0] })}>
                  Yes
                </button>
                <button className="pick no" onClick={() => onPick({ event, market: m, outcome: m.outcomes[1] })}>
                  No
                </button>
              </span>
            </div>
          ))}
          {ranked.length > 4 && (
            <button className="link more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show fewer' : `+${ranked.length - 4} more outcomes`}
            </button>
          )}
        </div>
      )}
      {!single && (
        <InView minHeight={0} margin="200px">
          <CardNews event={event} />
        </InView>
      )}
    </article>
  )
}
