import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatCents, removeAlert, useAlerts, type PriceAlert } from '../lib/alerts'
import {
  clearNotifications,
  disableBrowserNotifications,
  enableBrowserNotifications,
  markAllRead,
  markRead,
  openHref,
  useBrowserNotifications,
  useNotifications,
  type AppNotification,
  type NotificationKind,
} from '../lib/notifications'
import { disablePush, enablePush, usePushState } from '../lib/push'
import '../styles/notifications.css'

type Tab = 'inbox' | 'alerts'

/** "just now", "2m ago", "3h ago", "4d ago", then a short date. */
function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function BellIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

const KIND_LABEL: Record<NotificationKind, string> = {
  trade: 'Trade',
  deposit: 'Deposit',
  withdraw: 'Withdrawal',
  win: 'Win',
  alert: 'Price alert',
  ending: 'Ending soon',
  info: 'Info',
  error: 'Problem',
}

const KIND_GLYPH: Record<NotificationKind, ReactNode> = {
  // A candle: body plus wick, the brand motif.
  trade: (
    <>
      <path d="M12 3v4M12 17v4" />
      <rect x="8" y="7" width="8" height="10" rx="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  deposit: <path d="M12 4v13M6 11l6 6 6-6M5 20h14" />,
  withdraw: <path d="M12 20V7M6 13l6-6 6 6M5 4h14" />,
  win: <path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" fill="currentColor" />,
  alert: (
    <>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  ending: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5M9 2h6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  error: <path d="M12 4v10M12 19v.5" />,
}

function KindIcon({ kind }: { kind: NotificationKind }) {
  return (
    <span className={`nt-kind nt-kind-${kind}`} title={KIND_LABEL[kind]}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {KIND_GLYPH[kind]}
      </svg>
    </span>
  )
}

/** Bell with an unread badge; opens the inbox and price-alert panel. */
export function NotificationBell() {
  const { items, unread } = useNotifications()
  const alerts = useAlerts()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('inbox')
  const [now, setNow] = useState(() => Date.now())
  const wrap = useRef<HTMLDivElement>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) bell.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      bell.current?.focus()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(tick)
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active = alerts.filter((a) => !a.firedAt)
  const fired = alerts.filter((a) => a.firedAt).sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0))
  const badge = unread > 9 ? '9+' : String(unread)

  const openItem = (n: AppNotification) => {
    markRead(n.id)
    if (n.href) {
      close(!n.href.startsWith('#'))
      openHref(n.href)
    }
  }

  return (
    <div className="menu-wrap nt-wrap" ref={wrap}>
      <button
        ref={bell}
        className="icon nt-bell"
        onClick={() => {
          setNow(Date.now())
          setOpen((o) => !o)
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        title="Notifications"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="nt-count num" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="menu nt-panel" id={panelId} role="dialog" aria-label="Notifications">
          <div className="nt-head">
            <div className="nt-tabs" role="tablist" aria-label="Notification views">
              <TabButton id={`${panelId}-inbox`} active={tab === 'inbox'} onClick={() => setTab('inbox')}>
                Inbox{unread > 0 && <span className="nt-tab-count num">{badge}</span>}
              </TabButton>
              <TabButton id={`${panelId}-alerts`} active={tab === 'alerts'} onClick={() => setTab('alerts')}>
                Alerts{active.length > 0 && <span className="nt-tab-count num">{active.length}</span>}
              </TabButton>
            </div>
            {tab === 'inbox' && items.length > 0 && (
              <div className="nt-head-actions">
                <button className="link" onClick={markAllRead} disabled={unread === 0}>
                  Mark all read
                </button>
                <button className="link nt-clear" onClick={clearNotifications}>
                  Clear
                </button>
              </div>
            )}
          </div>

          <div className="nt-body" role="tabpanel" aria-labelledby={`${panelId}-${tab}`}>
            {tab === 'inbox' ? (
              items.length === 0 ? (
                <Empty title="All quiet." text="Set a price alert on any market and we'll ping you here. Fills, deposits and wins land here too." />
              ) : (
                <ul className="nt-list">
                  {items.map((n) => (
                    <li key={n.id}>
                      <button className={`nt-item${n.read ? '' : ' unread'}`} onClick={() => openItem(n)}>
                        <KindIcon kind={n.kind} />
                        <span className="nt-main">
                          <span className="nt-title">{n.title}</span>
                          {n.detail && <span className="nt-detail">{n.detail}</span>}
                          <span className="nt-time">
                            {relativeTime(n.createdAt, now)}
                            {n.href && !n.href.startsWith('#') && ' · opens in a new tab ↗'}
                          </span>
                        </span>
                        {!n.read && <span className="nt-dot" aria-label="Unread" />}
                      </button>
                      {n.link && (
                        <a
                          className="nt-explorer"
                          href={n.link.href}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => markRead(n.id)}
                        >
                          {n.link.label} ↗
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )
            ) : alerts.length === 0 ? (
              <Empty title="No alerts yet." text="Open any market and tap Alert. We'll nudge you when the price crosses your line." />
            ) : (
              <ul className="nt-list">
                {active.map((a) => (
                  <AlertRow key={a.id} alert={a} now={now} onNavigate={() => close(false)} />
                ))}
                {fired.length > 0 && <li className="nt-sep eyebrow">Recently fired</li>}
                {fired.map((a) => (
                  <AlertRow key={a.id} alert={a} now={now} onNavigate={() => close(false)} />
                ))}
              </ul>
            )}
          </div>

          <BrowserToggle />
          <PushToggle />
        </div>
      )}
    </div>
  )
}

function TabButton(props: { id: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button id={props.id} role="tab" aria-selected={props.active} className={`nt-tab${props.active ? ' active' : ''}`} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

function Empty(props: { title: string; text: string }) {
  return (
    <div className="nt-empty">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <path d="M12 6v6M12 28v6" stroke="var(--yes)" strokeWidth="2" strokeLinecap="round" />
        <rect x="8" y="12" width="8" height="16" rx="2" fill="var(--yes)" />
        <path d="M28 10v4M28 26v6" stroke="var(--no)" strokeWidth="2" strokeLinecap="round" />
        <rect x="24" y="14" width="8" height="12" rx="2" fill="var(--no)" />
      </svg>
      <strong>{props.title}</strong>
      <span>{props.text}</span>
    </div>
  )
}

function AlertRow(props: { alert: PriceAlert; now: number; onNavigate: () => void }) {
  const a = props.alert
  return (
    <li className={`nt-alert${a.firedAt ? ' fired' : ''}`}>
      <span className={`nt-op ${a.op}`} aria-hidden="true">
        {a.op === 'above' ? '↑' : '↓'}
      </span>
      <span className="nt-main">
        <span className="nt-title">
          {a.outcome} {a.op} <span className="num">{formatCents(a.price)}</span>
        </span>
        <a className="nt-detail nt-market" href={`#/market/${encodeURIComponent(a.slug)}`} onClick={props.onNavigate}>
          {a.title}
        </a>
        {a.firedAt && <span className="nt-time">Fired {relativeTime(a.firedAt, props.now)}</span>}
      </span>
      <button className="nt-remove" onClick={() => removeAlert(a.id)} aria-label={`Remove alert: ${a.outcome} ${a.op} ${formatCents(a.price)} on ${a.title}`}>
        ×
      </button>
    </li>
  )
}

function BrowserToggle() {
  const state = useBrowserNotifications()
  const [asking, setAsking] = useState(false)
  if (state === 'unsupported') {
    return <div className="nt-foot muted">Desktop notifications aren't available in this browser.</div>
  }
  if (state === 'denied') {
    return <div className="nt-foot muted">Desktop notifications are blocked. Allow them for this site in your browser settings.</div>
  }
  const on = state === 'on'
  return (
    <div className="nt-foot">
      <span>
        <span className="nt-foot-title">Desktop notifications</span>
        <span className="muted">When this tab is in the background</span>
      </span>
      <button
        role="switch"
        aria-checked={on}
        aria-label="Desktop notifications"
        className={`nt-switch${on ? ' on' : ''}`}
        disabled={asking}
        onClick={async () => {
          if (on) return disableBrowserNotifications()
          setAsking(true)
          await enableBrowserNotifications()
          setAsking(false)
        }}
      >
        <span className="nt-knob" />
      </button>
    </div>
  )
}

/** Server-side Web Push: alerts arrive even when every YayNay tab is closed. Hidden when unavailable. */
function PushToggle() {
  const state = usePushState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (state !== 'on' && state !== 'off') return null
  const on = state === 'on'
  return (
    <div className="nt-foot nt-foot-push">
      <span>
        <span className="nt-foot-title">Alerts when YayNay is closed</span>
        <span className="muted">We store only your alert targets and a push address; turning this off deletes them.</span>
        {error && (
          <span className="nt-hint" role="alert">
            {error}
          </span>
        )}
      </span>
      <button
        role="switch"
        aria-checked={on}
        aria-label="Alerts when YayNay is closed"
        className={`nt-switch${on ? ' on' : ''}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            if (on) await disablePush()
            else if ((await enablePush()) === 'off') setError('Allow notifications for this site to turn this on.')
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
          } finally {
            setBusy(false)
          }
        }}
      >
        <span className="nt-knob" />
      </button>
    </div>
  )
}
