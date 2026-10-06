import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchPolymarketActivityPage, loadLocalActivity, mergeActivity, type ActivityItem } from '../lib/activity'
import { FLOW, isTopUp, matchesFilter, netFlow, timeAgo, type ActivityFilter } from '../lib/dashboard'
import { routeHref } from '../lib/router'

export type ActivityFeed = {
  /** Null while the first page loads. */
  items: ActivityItem[] | null
  error: string
  /** More Polymarket history is available. */
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
}

/**
 * A wallet's Polymarket trades and claims, merged with the deposits, withdrawals and top-ups this browser
 * recorded for `arcAddress` (omit it on someone else's profile).
 */
export function useActivityFeed(wallet: string, arcAddress: string | undefined, refreshKey: number): ActivityFeed {
  const [remote, setRemote] = useState<ActivityItem[] | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchPolymarketActivityPage(wallet)
      .then((page) => {
        if (cancelled) return
        setRemote(page.items)
        setNext(page.next)
        setError('')
      })
      .catch((e) => {
        if (cancelled) return
        setRemote([])
        setNext(undefined)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [wallet, refreshKey])

  const loadMore = useCallback(() => {
    if (!next || loadingMore) return
    setLoadingMore(true)
    fetchPolymarketActivityPage(wallet, next)
      .then((page) => {
        setRemote((r) => mergeActivity(r ?? [], page.items))
        setNext(page.next)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMore(false))
  }, [wallet, next, loadingMore])

  const items = useMemo(
    () => (remote === null ? null : mergeActivity(remote, arcAddress ? loadLocalActivity(arcAddress) : [])),
    // refreshKey re-reads the browser's records after a deposit or withdrawal.
    [remote, arcAddress, refreshKey],
  )

  return { items, error, hasMore: !!next, loadingMore, loadMore }
}

/* ---------- presentation ---------- */

const LABEL: Record<ActivityItem['kind'], string> = {
  BUY: 'Bought',
  SELL: 'Sold',
  REDEEM: 'Claimed',
  DEPOSIT: 'Deposit',
  WITHDRAW: 'Withdrawal',
  OTHER: 'Activity',
}

const ICON: Record<ActivityItem['kind'], string> = {
  BUY: 'M8 13V3M3.5 7.5 8 3l4.5 4.5',
  SELL: 'M8 3v10M3.5 8.5 8 13l4.5-4.5',
  REDEEM: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  DEPOSIT: 'M8 2.5v7M4.8 6.5 8 9.7l3.2-3.2M3 13h10',
  WITHDRAW: 'M8 10V3M4.8 6 8 2.8 11.2 6M3 13h10',
  OTHER: 'M3 8h10M9.5 4.5 13 8l-3.5 3.5',
}

const FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'trades', label: 'Trades' },
  { id: 'claims', label: 'Claims' },
  { id: 'transfers', label: 'Transfers' },
]

const PAGE = 15

function dayKey(ts: number) {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(ts: number) {
  const d = new Date(ts * 1000)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(ts) === dayKey(today.getTime() / 1000)) return 'Today'
  if (dayKey(ts) === dayKey(yesterday.getTime() / 1000)) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

const usd = (n: number) => Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const isNo = (o?: string) => /^(no|down|under)$/i.test(o ?? '')

/** Deposit and withdrawal routes as a rail of stops: Arc → Circle CCTP → Polymarket. */
function RouteRail({ detail }: { detail: string }) {
  const stops = detail.split('→').map((s) => s.trim()).filter(Boolean)
  return (
    <span className="act-rail" aria-label={detail}>
      {stops.map((s, i) => (
        <span key={i} className={`act-stop${s === 'Arc' ? ' arc' : /polymarket/i.test(s) ? ' poly' : ''}`}>
          {s}
        </span>
      ))}
    </span>
  )
}

function Row({ a }: { a: ActivityItem }) {
  const flow = FLOW[a.kind]
  const trade = a.kind === 'BUY' || a.kind === 'SELL'
  const transfer = a.kind === 'DEPOSIT' || a.kind === 'WITHDRAW'
  const title = a.eventSlug ? <a href={routeHref({ name: 'market', slug: a.eventSlug })}>{a.title}</a> : a.title
  return (
    <li className={`act-row k-${a.kind.toLowerCase()}${isTopUp(a) ? ' k-topup' : ''}`}>
      <span className="act-thumb">
        {a.icon ? <img src={a.icon} alt="" loading="lazy" /> : <span className="act-thumb-blank" />}
        <span className="act-badge" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 16 16">
            <path d={ICON[a.kind]} />
          </svg>
        </span>
      </span>
      <div className="act-main">
        <div className="act-title">
          <span className="act-kind">{LABEL[a.kind]}</span>
          <span className="act-name">{title}</span>
        </div>
        <div className="act-meta num">
          {trade && a.outcome && <span className={`badge ${isNo(a.outcome) ? 'no' : 'yes'}`}>{a.outcome}</span>}
          {trade && typeof a.shares === 'number' && typeof a.price === 'number' ? (
            <span>
              {a.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })} shares @ {(a.price * 100).toFixed(1)}¢
            </span>
          ) : transfer ? (
            <RouteRail detail={a.detail} />
          ) : (
            <span className="act-detail">{a.detail}</span>
          )}
        </div>
      </div>
      <div className="act-side num">
        <b className={flow > 0 ? 'in' : flow < 0 ? 'out' : undefined}>
          {flow > 0 ? '+' : flow < 0 ? '−' : ''}${usd(a.usd)}
        </b>
        <span className="act-when">
          <time dateTime={new Date(a.timestamp * 1000).toISOString()} title={new Date(a.timestamp * 1000).toLocaleString()}>
            {timeAgo(a.timestamp)}
          </time>
          {a.href && (
            <a href={a.href} target="_blank" rel="noreferrer" title={`View on ${a.hrefLabel ?? 'explorer'}`}>
              {a.hrefLabel ?? 'Tx'} ↗
            </a>
          )}
        </span>
      </div>
    </li>
  )
}

/** Day-grouped feed of trades, claims and transfers, with filters, search and a net figure per day. */
export function ActivityPanel({ feed, sub }: { feed: ActivityFeed; sub?: string }) {
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const all = useMemo(() => feed.items ?? [], [feed.items])

  const counts = useMemo(() => {
    const c = { all: 0, trades: 0, claims: 0, transfers: 0 } as Record<ActivityFilter, number>
    for (const a of all) for (const f of FILTERS) if (matchesFilter(a, f.id)) c[f.id]++
    return c
  }, [all])

  const q = query.trim().toLowerCase()
  const filtered = all.filter((a) => matchesFilter(a, filter) && (!q || a.title.toLowerCase().includes(q) || (a.outcome ?? '').toLowerCase().includes(q)))
  const visible = filtered.slice(0, limit)

  const groups: { key: string; label: string; items: ActivityItem[]; net: number }[] = []
  for (const a of visible) {
    const key = dayKey(a.timestamp)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(a)
    else groups.push({ key, label: dayLabel(a.timestamp), items: [a], net: 0 })
  }
  // The day's net uses every loaded item of that day, not just the visible slice.
  for (const g of groups) g.net = netFlow(filtered.filter((a) => dayKey(a.timestamp) === g.key))

  const more = filtered.length - visible.length
  const showMore = () => {
    setLimit((l) => l + PAGE * 2)
    if (more <= PAGE * 2 && feed.hasMore) feed.loadMore()
  }

  return (
    <section className="card pf-card act" aria-labelledby="act-h">
      <div className="pf-card-head">
        <div>
          <h2 id="act-h">Activity</h2>
          <p className="pf-card-sub">{sub ?? 'Every trade, claim and transfer, newest first.'}</p>
        </div>
        <label className="act-search">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            type="search"
            placeholder="Search markets"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(PAGE)
            }}
            aria-label="Search activity"
          />
        </label>
      </div>

      <div className="act-filters" role="group" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`act-filter${filter === f.id ? ' on' : ''}`}
            aria-pressed={filter === f.id}
            onClick={() => {
              setFilter(f.id)
              setLimit(PAGE)
            }}
          >
            {f.label}
            <span className="pf-count">
              {counts[f.id]}
              {feed.hasMore && f.id !== 'transfers' ? '+' : ''}
            </span>
          </button>
        ))}
      </div>

      {feed.error && <p className="pf-warn">Polymarket activity is unavailable right now. Showing what this browser remembers.</p>}

      {feed.items === null ? (
        <div className="pf-loading" aria-label="Loading activity">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="pf-empty-inline small">
          <h3>{all.length === 0 ? 'Quiet so far.' : 'Nothing matches.'}</h3>
          <p>{all.length === 0 ? 'Deposits, trades and withdrawals show up here.' : 'Try another filter or search.'}</p>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <div className="act-day" key={g.key}>
              <div className="act-day-head">
                <span className="act-day-label">{g.label}</span>
                <span className="act-day-rule" aria-hidden="true" />
                <span className={`act-day-net num ${g.net > 0.004 ? 'in' : g.net < -0.004 ? 'out' : ''}`}>
                  {g.items.length} {g.items.length === 1 ? 'move' : 'moves'}
                  {Math.abs(g.net) > 0.004 && (
                    <>
                      {' · net '}
                      {g.net > 0 ? '+' : '−'}${usd(g.net)}
                    </>
                  )}
                </span>
              </div>
              <ol className="act-list">
                {g.items.map((a) => (
                  <Row key={a.id} a={a} />
                ))}
              </ol>
            </div>
          ))}
          {(more > 0 || feed.hasMore) && (
            <button className="subtle pf-more" onClick={showMore} disabled={feed.loadingMore}>
              {feed.loadingMore ? 'Loading…' : more > 0 ? `Show more (${more}${feed.hasMore ? '+' : ''})` : 'Load older activity'}
            </button>
          )}
        </>
      )}
    </section>
  )
}

/** The portfolio's activity card for a connected wallet. */
export function Activity({ wallet, arcAddress, refreshKey }: { wallet: string; arcAddress: string; refreshKey: number }) {
  const feed = useActivityFeed(wallet, arcAddress, refreshKey)
  return <ActivityPanel feed={feed} />
}
