import { pageWindow } from '../lib/pager'

/** Numbered pager: ‹ 1 2 3 … 40 ›. Pages are 0-based inside, 1-based on screen. */
export function Pagination(props: { page: number; pages: number; disabled?: boolean; onPage: (page: number) => void }) {
  const { page, pages } = props
  return (
    <nav className="pager" aria-label="Market pages">
      <button className="pager-step" disabled={props.disabled || page === 0} onClick={() => props.onPage(page - 1)} aria-label="Previous page">
        ‹ <span>Prev</span>
      </button>
      <ol>
        {pageWindow(page, pages).map((p, i) =>
          p === null ? (
            <li key={`gap${i}`} className="pager-gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={p}>
              <button
                className={p === page ? 'on' : ''}
                aria-current={p === page ? 'page' : undefined}
                aria-label={`Page ${p + 1}`}
                disabled={props.disabled && p !== page}
                onClick={() => p !== page && props.onPage(p)}
              >
                {p + 1}
              </button>
            </li>
          ),
        )}
      </ol>
      <button className="pager-step" disabled={props.disabled || page >= pages - 1} onClick={() => props.onPage(page + 1)} aria-label="Next page">
        <span>Next</span> ›
      </button>
    </nav>
  )
}
