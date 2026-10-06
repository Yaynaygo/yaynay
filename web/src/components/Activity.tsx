import { useEffect, useState } from 'react'
import { fetchPolymarketActivity, loadLocalActivity, type ActivityItem } from '../lib/activity'

export function Activity({ wallet, arcAddress, refreshKey }: { wallet: string; arcAddress: string; refreshKey: number }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchPolymarketActivity(wallet)
      .then((remote) => {
        if (cancelled) return
        const merged = [...remote, ...loadLocalActivity(arcAddress)].sort((a, b) => b.timestamp - a.timestamp)
        setItems(merged)
        setError('')
      })
      .catch((e) => {
        if (cancelled) return
        setItems(loadLocalActivity(arcAddress))
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [wallet, arcAddress, refreshKey])

  return <ActivityList items={items} error={error} />
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

// Sign from the point of view of the trading balance: money in is +, money out is −.
const FLOW: Record<ActivityItem['kind'], 1 | -1 | 0> = { BUY: -1, SELL: 1, REDEEM: 1, DEPOSIT: 1, WITHDRAW: -1, OTHER: 0 }

const ICON: Record<ActivityItem['kind'], string> = {
  BUY: 'M8 13V3M3.5 7.5 8 3l4.5 4.5',
  SELL: 'M8 3v10M3.5 8.5 8 13l4.5-4.5',
  REDEEM: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  DEPOSIT: 'M8 2.5v7M4.8 6.5 8 9.7l3.2-3.2M3 13h10',
  WITHDRAW: 'M8 10V3M4.8 6 8 2.8 11.2 6M3 13h10',
  OTHER: 'M5 8h6',
}

const PAGE = 12

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

const time = (ts: number) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** Day-grouped timeline of trades, claims, deposits and withdrawals. */
export function ActivityList({ items, error }: { items: ActivityItem[] | null; error: string }) {
  const [limit, setLimit] = useState(PAGE)
  const all = items?.slice(0, 40) ?? []
  const visible = all.slice(0, limit)
  const groups: { key: string; label: string; items: ActivityItem[] }[] = []
  for (const a of visible) {
    const key = dayKey(a.timestamp)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(a)
    else groups.push({ key, label: dayLabel(a.timestamp), items: [a] })
  }

  return (
    <section className="card pf-card" aria-labelledby="pf-activity-h">
      <div className="pf-card-head">
        <div>
          <h2 id="pf-activity-h">Activity</h2>
          <p className="pf-card-sub">Trades and claims from Polymarket, plus deposits and withdrawals made in this browser.</p>
        </div>
      </div>
      {error && <p className="pf-warn">Polymarket activity is unavailable right now. Showing what this browser remembers.</p>}
      {items === null ? (
        <div className="pf-loading" aria-label="Loading activity">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : all.length === 0 ? (
        <div className="pf-empty-inline small">
          <h3>Quiet so far.</h3>
          <p>Your deposits, trades and withdrawals will show up here.</p>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <div className="pf-day" key={g.key}>
              <div className="pf-day-label">{g.label}</div>
              <ol className="pf-feed">
                {g.items.map((a) => {
                  const flow = FLOW[a.kind]
                  return (
                    <li key={a.id} className={`pf-ev k-${a.kind.toLowerCase()}`}>
                      <span className="pf-ev-ico" aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 16 16">
                          <path d={ICON[a.kind]} />
                        </svg>
                      </span>
                      <div className="pf-ev-main">
                        <div className="pf-ev-title">
                          <span className="pf-ev-kind">{LABEL[a.kind]}</span>
                          <span className="pf-ev-name">{a.title}</span>
                        </div>
                        <div className="pf-ev-detail num">
                          {a.detail}
                          <span aria-hidden="true"> · </span>
                          <time dateTime={new Date(a.timestamp * 1000).toISOString()}>{time(a.timestamp)}</time>
                        </div>
                      </div>
                      <div className="pf-ev-side num">
                        <b className={flow > 0 ? 'in' : undefined}>
                          {flow > 0 ? '+' : flow < 0 ? '−' : ''}${a.usd.toFixed(2)}
                        </b>
                        {a.href && (
                          <a href={a.href} target="_blank" rel="noreferrer">
                            {a.hrefLabel ?? 'Tx'} ↗
                          </a>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}
          {all.length > limit && (
            <button className="subtle pf-more" onClick={() => setLimit(all.length)}>
              Show {all.length - limit} more
            </button>
          )}
        </>
      )}
    </section>
  )
}
