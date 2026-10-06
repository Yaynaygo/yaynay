import { useState } from 'react'
import { toggleWatch, useWatchlist } from '../lib/watchlist'
import '../styles/notifications.css'
import { track } from '../lib/progress'

/** Star toggle for the watchlist. Safe inside card links: it never triggers the parent link. */
export function WatchButton(props: { slug: string; title: string; image?: string; compact?: boolean }) {
  const watched = useWatchlist().some((w) => w.slug === props.slug)
  // Bumped on every star-on so the pop animation restarts.
  const [pop, setPop] = useState(0)
  const label = watched ? 'Watching' : 'Watch'
  return (
    <button
      type="button"
      className={`nt-watch${props.compact ? ' compact' : ''}${watched ? ' on' : ''}`}
      aria-pressed={watched}
      aria-label={props.compact ? `Watch ${props.title}` : undefined}
      title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (toggleWatch({ slug: props.slug, title: props.title, image: props.image })) {
          setPop((p) => p + 1)
          track('watch_added', { slug: props.slug })
        }
      }}
    >
      <svg key={pop} className={pop ? 'nt-star nt-popping' : 'nt-star'} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6L12 17l-5.38 2.85 1.03-6L3.3 9.6l6-.9z"
          fill={watched ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      {!props.compact && <span>{label}</span>}
    </button>
  )
}
