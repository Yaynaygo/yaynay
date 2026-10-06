import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BRAND } from '../config'
import { DOCS, findDoc, type DocPage } from '../docs/pages'
import { navigate, routeHref } from '../lib/router'
import { track } from '../lib/progress'
import '../styles/docs.css'

const GROUPS = ['Guide', 'Trust', 'Legal'] as const
const GROUP_BLURB: Record<DocPage['group'], string> = {
  Guide: 'Learn the ropes',
  Trust: 'Verify, don’t trust',
  Legal: 'The fine print',
}

// Small line icons per page, drawn on a 24px grid with currentColor strokes.
const ICONS: Record<string, ReactNode> = {
  'how-it-works': (
    <>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="12" r="2.5" />
      <path d="M7.5 12h9M13.5 9l3 3-3 3" />
    </>
  ),
  fees: (
    <>
      <path d="M4 7.5 12 4l8 3.5v4.5c0 4.4-3.4 7.4-8 8-4.6-.6-8-3.6-8-8Z" />
      <path d="M9.5 14.5 14.5 9.5M9.8 10h.01M14.2 14h.01" />
    </>
  ),
  troubleshooting: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4M11 8v3.5M11 14h.01" />
    </>
  ),
  faq: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V17h-.5A1.5 1.5 0 0 1 4 15.5Z" />
      <path d="M10 8.8a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.4M12 14.3h.01" />
    </>
  ),
  security: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.5v2.5" />
    </>
  ),
  contracts: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  risks: (
    <>
      <path d="M12 4 21 19.5H3Z" />
      <path d="M12 10v4.2M12 16.8h.01" />
    </>
  ),
  terms: (
    <>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5Z" />
      <path d="M13.5 3.5V8H18M9.5 12h5M9.5 15.5h5" />
    </>
  ),
  privacy: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
}

function DocIcon({ slug, size = 18 }: { slug: string; size?: number }) {
  return (
    <svg
      className="dc-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[slug] ?? ICONS.faq}
    </svg>
  )
}

type Heading = { id: string; text: string }

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'section'

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * Scrolls to a heading without touching the hash: the hash is the router's (`#/docs/<page>`),
 * so a classic `#anchor` link would navigate away.
 */
function scrollToHeading(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}

/** Reads the rendered body: gives each <h3> an id and counts words for the reading time. */
function useOutline(slug: string) {
  const ref = useRef<HTMLDivElement>(null)
  const [outline, setOutline] = useState<{ slug: string; headings: Heading[]; minutes: number }>({
    slug: '',
    headings: [],
    minutes: 1,
  })
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const seen = new Map<string, number>()
    const headings = Array.from(root.querySelectorAll('h3')).map((h) => {
      const text = h.textContent?.trim() ?? ''
      const base = `dc-${slugify(text)}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      const id = n ? `${base}-${n + 1}` : base
      h.id = id
      h.tabIndex = -1
      return { id, text }
    })
    const words = (root.textContent ?? '').split(/\s+/).filter(Boolean).length
    setOutline({ slug, headings, minutes: Math.max(1, Math.round(words / 220)) })
  }, [slug])
  return { ref, ...outline }
}

/** Highlights the section currently at the top of the viewport. */
function useActiveHeading(headings: Heading[]) {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    if (headings.length === 0) return
    const update = () => {
      let current: string | null = headings[0].id
      for (const h of headings) {
        const el = document.getElementById(h.id)
        if (el && el.getBoundingClientRect().top < 140) current = h.id
      }
      setActive(current)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [headings])
  return active
}

function Toc({ headings, active, className }: { headings: Heading[]; active: string | null; className: string }) {
  if (headings.length < 2) return null
  return (
    <nav className={className} aria-label="On this page">
      <div className="eyebrow">On this page</div>
      <ul>
        {headings.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              className={h.id === active ? 'active' : undefined}
              aria-current={h.id === active ? 'location' : undefined}
              onClick={() => scrollToHeading(h.id)}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function PageCard({ page, dir }: { page: DocPage; dir: 'prev' | 'next' }) {
  return (
    <a className={`dc-pager-card ${dir}`} href={routeHref({ name: 'docs', page: page.slug })}>
      <span className="eyebrow">{dir === 'prev' ? '← Previous' : 'Next →'}</span>
      <span className="dc-pager-title">
        <DocIcon slug={page.slug} size={16} />
        {page.title}
      </span>
      <span className="dc-pager-sum">{page.summary}</span>
    </a>
  )
}

export function Docs({ page }: { page: string }) {
  const current = findDoc(page)
  useEffect(() => {
    document.title = `${current.title} · ${BRAND.name}`
    track('docs_read', { page: current.slug })
  }, [current])

  const { ref, headings, minutes, slug: outlined } = useOutline(current.slug)
  const fresh = outlined === current.slug
  const active = useActiveHeading(fresh ? headings : [])

  const index = DOCS.findIndex((d) => d.slug === current.slug)
  const prev = index > 0 ? DOCS[index - 1] : null
  const next = index < DOCS.length - 1 ? DOCS[index + 1] : null
  const helpLinks = DOCS.filter((d) => (d.slug === 'troubleshooting' || d.slug === 'faq') && d.slug !== current.slug)

  return (
    <div className="dc">
      <aside className="dc-side">
        <nav className="dc-nav" aria-label="Documentation">
          {GROUPS.map((g) => (
            <div key={g} className="dc-nav-group">
              <div className="eyebrow">{g}</div>
              <ul>
                {DOCS.filter((d) => d.group === g).map((d) => (
                  <li key={d.slug}>
                    <a
                      href={routeHref({ name: 'docs', page: d.slug })}
                      className={d.slug === current.slug ? 'active' : undefined}
                      aria-current={d.slug === current.slug ? 'page' : undefined}
                    >
                      <DocIcon slug={d.slug} size={16} />
                      <span>{d.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <label className="dc-select">
          <span className="eyebrow">Jump to</span>
          <select value={current.slug} onChange={(e) => navigate({ name: 'docs', page: e.target.value })}>
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {DOCS.filter((d) => d.group === g).map((d) => (
                  <option key={d.slug} value={d.slug}>
                    {d.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </aside>

      <article className={`card dc-article group-${current.group.toLowerCase()}`} key={current.slug}>
        <header className="dc-hero">
          <div className="dc-hero-text">
            <div className="dc-crumbs">
              <a href={routeHref({ name: 'docs', page: DOCS[0].slug })}>Learn</a>
              <span aria-hidden="true">/</span>
              <span className="dc-group">{current.group}</span>
              <span aria-hidden="true">·</span>
              <span>{GROUP_BLURB[current.group]}</span>
            </div>
            <h1>{current.title}</h1>
            <p className="dc-lead">{current.summary}</p>
            <div className="dc-meta">
              <span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                {minutes} min read
              </span>
              {fresh && headings.length > 0 && (
                <span>
                  {headings.length} section{headings.length === 1 ? '' : 's'}
                </span>
              )}
              <span>
                Page {index + 1} of {DOCS.length}
              </span>
            </div>
          </div>
          <div className="dc-hero-badge" aria-hidden="true">
            <DocIcon slug={current.slug} size={34} />
          </div>
        </header>

        <Toc headings={fresh ? headings : []} active={active} className="dc-toc-inline" />

        <div className="dc-prose" ref={ref}>
          {current.body()}
        </div>

        <footer className="dc-end">
          {(prev || next) && (
            <div className="dc-pager">
              {prev ? <PageCard page={prev} dir="prev" /> : <span />}
              {next ? <PageCard page={next} dir="next" /> : <span />}
            </div>
          )}
          <div className="dc-stuck">
            <div className="dc-stuck-mark" aria-hidden="true">
              ?
            </div>
            <div className="dc-stuck-text">
              <b>Still stuck?</b>
              <span>Funds look missing or a word makes no sense? These two pages answer most questions.</span>
            </div>
            <div className="dc-stuck-links">
              {helpLinks.map((d) => (
                <a key={d.slug} href={routeHref({ name: 'docs', page: d.slug })}>
                  <DocIcon slug={d.slug} size={15} />
                  {d.title}
                </a>
              ))}
            </div>
          </div>
        </footer>
      </article>

      <aside className="dc-rail">
        <Toc headings={fresh ? headings : []} active={active} className="dc-toc" />
      </aside>
    </div>
  )
}
