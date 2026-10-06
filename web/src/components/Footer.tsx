import { useEffect, useState } from 'react'
import { BRAND, BUILD, CLOB_API, LINKS, arc } from '../config'
import { routeHref, type Route } from '../lib/router'
import { Logo } from './Logo'
import '../styles/footer.css'

type Health = 'checking' | 'ok' | 'degraded'

async function ping(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/** Checks the two services every action depends on: the Arc RPC and Polymarket's order book. */
function useHealth(): { state: Health; detail: string } {
  const [health, setHealth] = useState<{ state: Health; detail: string }>({ state: 'checking', detail: 'Checking services…' })
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const [arcOk, clobOk] = await Promise.all([
        ping(arc.rpcUrls.default.http[0], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        }),
        ping(`${CLOB_API}/time`),
      ])
      if (cancelled) return
      const down = [!arcOk && 'Arc RPC', !clobOk && 'Polymarket'].filter(Boolean)
      setHealth(
        down.length === 0
          ? { state: 'ok', detail: 'Arc and Polymarket are reachable' }
          : { state: 'degraded', detail: `${down.join(' and ')} not reachable right now` },
      )
    }
    check()
    const id = setInterval(check, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])
  return health
}

const doc = (page: string): Route => ({ name: 'docs', page })

const COLUMNS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Markets', href: routeHref({ name: 'markets' }) },
      { label: 'Portfolio', href: routeHref({ name: 'portfolio' }) },
      { label: 'Deposit & withdraw', href: routeHref({ name: 'wallet' }) },
      { label: 'Quests', href: routeHref({ name: 'quests' }) },
    ],
  },
  {
    title: 'Learn',
    links: [
      { label: 'How it works', href: routeHref(doc('how-it-works')) },
      { label: 'Fees', href: routeHref(doc('fees')) },
      { label: 'Where are my funds?', href: routeHref(doc('troubleshooting')) },
      { label: 'FAQ & glossary', href: routeHref(doc('faq')) },
      { label: 'Help & contact', href: routeHref(doc('support')) },
    ],
  },
  {
    title: 'Trust',
    links: [
      { label: 'Security & what you sign', href: routeHref(doc('security')) },
      { label: 'Contracts & addresses', href: routeHref(doc('contracts')) },
      { label: 'Polymarket status', href: 'https://status.polymarket.com', external: true },
      { label: 'Circle status', href: 'https://status.circle.com', external: true },
      ...(LINKS.github ? [{ label: 'Source code', href: LINKS.github, external: true }] : []),
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms of use', href: routeHref(doc('terms')) },
      { label: 'Privacy', href: routeHref(doc('privacy')) },
      { label: 'Risk disclosure', href: routeHref(doc('risks')) },
      { label: 'Polymarket terms', href: LINKS.polymarketTos, external: true },
    ],
  },
]

/** A deterministic random walk of candles: decoration only, same shape on every render. */
const CANDLES = (() => {
  let seed = 7
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  let price = 30
  return Array.from({ length: 48 }, (_, i) => {
    const open = price
    // A slow wave plus noise, so the row reads like a real chart rather than static.
    const drift = Math.sin(i / 5) * 4 + (rand() - 0.5) * 14
    const close = Math.min(50, Math.max(10, open + drift))
    price = close
    const top = Math.min(open, close)
    const bottom = Math.max(open, close)
    return { up: close <= open, top, bottom: Math.max(bottom, top + 5), hi: top - 2 - rand() * 6, lo: Math.max(bottom, top + 5) + 2 + rand() * 6 }
  })
})()

function CandleRow() {
  const w = 24
  return (
    <svg className="ft-candles" viewBox={`0 0 ${CANDLES.length * w} 60`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {CANDLES.map((c, i) => {
        const x = i * w + w / 2
        return (
          <g key={i} className={`ft-candle ${c.up ? 'up' : 'down'}${i === CANDLES.length - 1 ? ' last' : ''}`} style={{ animationDelay: `${(i % 16) * 0.12}s` }}>
            <line x1={x} x2={x} y1={c.hi} y2={c.lo} />
            <rect x={x - 5.5} y={c.top} width="11" height={c.bottom - c.top} rx="2" />
          </g>
        )
      })}
    </svg>
  )
}

export function Footer() {
  const health = useHealth()
  return (
    <footer className="ft">
      <div className="container">
        <section className="ft-band" aria-label={BRAND.tagline}>
          <div className="ft-band-text">
            <p className="ft-wordmark" aria-hidden="true">
              <span className="ft-yay">Yay</span> <span className="ft-or">or</span> <span className="ft-nay">nay?</span>
            </p>
            <p className="ft-pitch">{BRAND.pitch}</p>
          </div>
          <div className="ft-band-cta">
            <a className="ft-cta primary" href={routeHref({ name: 'markets' })}>
              Make a call →
            </a>
            <a className="ft-cta" href={routeHref(doc('how-it-works'))}>
              How it works
            </a>
          </div>
        </section>

        <CandleRow />

        <div className="ft-grid">
          <div className="ft-brand">
            <div className="brand">
              <Logo size={26} />
              <span>
                <b>{BRAND.lead}</b>
                <em>{BRAND.tail}</em>
              </span>
            </div>
            <p>An independent, non-custodial interface for Polymarket, built on Arc. Fund with USDC on Arc, trade, and withdraw back.</p>
            <div className={`health ft-health ${health.state}`} role="status">
              <span className="health-dot" /> {health.detail}
            </div>
            {(LINKS.x || LINKS.github) && (
              <div className="ft-socials">
                {LINKS.x && (
                  <a href={LINKS.x} target="_blank" rel="noreferrer">
                    X ↗
                  </a>
                )}
                {LINKS.github && (
                  <a href={LINKS.github} target="_blank" rel="noreferrer">
                    GitHub ↗
                  </a>
                )}
              </div>
            )}
          </div>
          {COLUMNS.map((col) => (
            <nav key={col.title} className="ft-col" aria-label={col.title}>
              <div className="eyebrow">{col.title}</div>
              <ul>
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})}>
                      {l.label}
                      {l.external && <span className="ft-ext"> ↗</span>}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="ft-legal">
          <p>
            {BRAND.name} is an independent interface and is not affiliated with, endorsed by, or operated by Polymarket.
            Markets are operated by Polymarket and its Terms apply. Prediction markets are not available in restricted
            jurisdictions. Nothing here is financial advice; you can lose the full amount of any position.
          </p>
          <p>
            Arc™ is a trademark of Circle Internet Group, Inc. and/or its affiliates. USDC is issued by Circle. {BRAND.name} is
            not affiliated with or endorsed by Circle.
          </p>
          <p className="mono ft-build">
            v{BUILD.version} · {BUILD.commit} · {BRAND.name} fee 0%
            {LINKS.contact && (
              <>
                {' '}
                · <a href={LINKS.contact}>Contact</a>
              </>
            )}
          </p>
        </div>
      </div>
    </footer>
  )
}
