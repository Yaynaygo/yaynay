import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Mounts its children once they come within `margin` of the viewport, so heavy cards below the fold
 * (and their API calls) wait until the user scrolls towards them.
 */
export function InView({ children, margin = '400px', minHeight = 160 }: { children: ReactNode; margin?: string; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (seen || !el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin: margin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [seen, margin])
  return seen ? <>{children}</> : <div ref={ref} style={{ minHeight }} aria-hidden="true" />
}
