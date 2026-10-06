import { useId } from 'react'

/**
 * The YayNay mark: two candles side by side, a mint one rising (yay) and a coral one falling (nay).
 * The tile is drawn from CSS (see `.logo` in index.css) so it turns light or dark with the theme.
 */
export function Logo({ size = 28 }: { size?: number }) {
  const gradient = useId()
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="logo-top" />
          <stop offset="1" className="logo-bottom" />
        </linearGradient>
      </defs>
      <rect className="logo-tile" x="0.6" y="0.6" width="30.8" height="30.8" rx="8.6" fill={`url(#${gradient})`} />
      <path className="logo-yay" d="M11 5.5v21" strokeWidth="1.8" strokeLinecap="round" />
      <rect className="logo-yay" x="7.6" y="8.5" width="6.8" height="13" rx="2" strokeWidth="0" />
      <path className="logo-nay" d="M21 9.5v18" strokeWidth="1.8" strokeLinecap="round" />
      <rect className="logo-nay" x="17.6" y="13.5" width="6.8" height="10" rx="2" strokeWidth="0" />
    </svg>
  )
}
