import { useEffect, useRef, useState } from 'react'
import type { Connector } from 'wagmi'
import { BRAND, explorer, shortAddress } from '../config'
import { navigate, routeHref, type Route } from '../lib/router'
import { LiveAmount } from './LiveAmount'
import { Logo } from './Logo'
import { NotificationBell } from './Notifications'

type Theme = 'light' | 'dark'

const NAV: { route: Route; label: string; match: Route['name'][] }[] = [
  { route: { name: 'markets' }, label: 'Markets', match: ['markets', 'market'] },
  { route: { name: 'portfolio' }, label: 'Portfolio', match: ['portfolio'] },
  { route: { name: 'wallet' }, label: 'Wallet', match: ['wallet'] },
  { route: { name: 'leaderboard' }, label: 'Leaders', match: ['leaderboard', 'profile'] },
  { route: { name: 'quests' }, label: 'Quests', match: ['quests'] },
  { route: { name: 'docs', page: 'how-it-works' }, label: 'Learn', match: ['docs'] },
]

export function Header(props: {
  route: Route
  theme: Theme
  onToggleTheme: () => void
  isConnected: boolean
  address?: string
  chainName?: string
  polyWallet: string | null
  arcUsdc: string | null
  pusd: string | null
  linked: boolean
  linkDisabled: boolean
  onConnectClick: () => void
  onLink: () => void
  onSignOut: () => void
}) {
  return (
    <header className="topbar">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="container topbar-inner">
        <a className="brand" href={routeHref({ name: 'markets' })} aria-label={`${BRAND.name} home`}>
          <Logo />
          <span>
            <b>{BRAND.lead}</b>
            <em>{BRAND.tail}</em>
          </span>
        </a>
        <nav className="tabs" aria-label="Main">
          {NAV.map((n) => {
            const active = n.match.includes(props.route.name)
            return (
              <a key={n.label} className={`tab${active ? ' active' : ''}`} href={routeHref(n.route)} aria-current={active ? 'page' : undefined}>
                {n.label}
              </a>
            )
          })}
        </nav>
        <div className="topbar-right">
          <NotificationBell />
          <button
            className="icon"
            onClick={props.onToggleTheme}
            aria-label={props.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            title={props.theme === 'light' ? 'Dark theme' : 'Light theme'}
          >
            {props.theme === 'light' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="4.5" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            )}
          </button>
          {props.isConnected && (
            <div className="balance-pill num">
              <span>
                <span className="label">Arc</span>
                <span className="value">
                  <LiveAmount value={props.arcUsdc} />
                </span>
              </span>
              {props.polyWallet && (
                <span>
                  <span className="label">Trading</span>
                  <span className="value">
                    <LiveAmount value={props.pusd} />
                  </span>
                </span>
              )}
            </div>
          )}
          {!props.isConnected ? (
            <button onClick={props.onConnectClick}>Connect wallet</button>
          ) : !props.linked ? (
            <button disabled={props.linkDisabled} onClick={props.onLink}>
              Link account
            </button>
          ) : null}
          {props.isConnected && props.address && (
            <AccountMenu
              address={props.address}
              chainName={props.chainName}
              polyWallet={props.polyWallet}
              arcUsdc={props.arcUsdc}
              pusd={props.pusd}
              onSignOut={props.onSignOut}
            />
          )}
        </div>
      </div>
    </header>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="link"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function AccountMenu(props: {
  address: string
  chainName?: string
  polyWallet: string | null
  arcUsdc: string | null
  pusd: string | null
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="ghost account-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" aria-label="Account menu">
        <span className="dot" />
        <span className="mono">{shortAddress(props.address)}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-section">
            <div className="eyebrow">Arc wallet{props.chainName ? ` · on ${props.chainName}` : ''}</div>
            <div className="menu-row">
              <span className="mono">{shortAddress(props.address)}</span>
              <span className="menu-actions">
                <CopyButton value={props.address} />
                <a href={explorer.arcAddress(props.address)} target="_blank" rel="noreferrer">
                  Explorer ↗
                </a>
              </span>
            </div>
            <div className="muted">
              USDC <LiveAmount value={props.arcUsdc} />
            </div>
          </div>
          {props.polyWallet && (
            <div className="menu-section">
              <div className="eyebrow">Polymarket wallet · Polygon</div>
              <div className="menu-row">
                <span className="mono">{shortAddress(props.polyWallet)}</span>
                <span className="menu-actions">
                  <CopyButton value={props.polyWallet} />
                  <a href={explorer.polygonAddress(props.polyWallet)} target="_blank" rel="noreferrer">
                    Explorer ↗
                  </a>
                </span>
              </div>
              <div className="muted">
                pUSD <LiveAmount value={props.pusd} />
              </div>
            </div>
          )}
          <div className="menu-section">
            <button className="link" onClick={() => (setOpen(false), navigate({ name: 'portfolio' }))}>
              Portfolio &amp; activity
            </button>
            <button className="link" onClick={() => (setOpen(false), navigate({ name: 'docs', page: 'security' }))}>
              What you sign &amp; security
            </button>
          </div>
          <button className="ghost block" onClick={props.onSignOut}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}

/** Wallet picker: every wallet the browser announces (EIP-6963), or help when there is none. */
export function ConnectModal(props: {
  connectors: readonly Connector[]
  error: string
  pending: boolean
  onPick: (c: Connector) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [props])

  // Prefer the named wallets announced via EIP-6963 over the generic "Injected" connector.
  const named = props.connectors.filter((c) => c.type === 'injected' && c.id !== 'injected')
  const list = named.length > 0 ? named : props.connectors.filter(() => typeof window !== 'undefined' && 'ethereum' in window)

  return (
    <>
      <div className="overlay" onClick={props.onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" ref={dialog}>
        <div className="modal-head">
          <h2 id="connect-title">Connect a wallet</h2>
          <button className="close" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="sub">Use the wallet that holds your USDC on Arc. You keep your keys; we never see them.</p>
        {list.length === 0 ? (
          <div className="notice info">
            No browser wallet found. Install an EVM wallet such as{' '}
            <a href="https://metamask.io/download" target="_blank" rel="noreferrer">
              MetaMask
            </a>{' '}
            or{' '}
            <a href="https://rabby.io" target="_blank" rel="noreferrer">
              Rabby
            </a>
            , then reload this page.
          </div>
        ) : (
          <div className="wallet-list">
            {list.map((c) => (
              <button key={c.uid} className="wallet-option" disabled={props.pending} onClick={() => props.onPick(c)}>
                {c.icon ? <img src={c.icon} alt="" width={28} height={28} /> : <span className="wallet-fallback" />}
                <span>{c.id === 'injected' ? 'Browser wallet' : c.name}</span>
                <span className="muted">{props.pending ? 'Connecting…' : 'Installed'}</span>
              </button>
            ))}
          </div>
        )}
        {props.error && <div className="notice err">{props.error}</div>}
        <p className="muted" style={{ marginTop: 12 }}>
          By connecting you agree to the <a href={routeHref({ name: 'docs', page: 'terms' })}>Terms</a> and acknowledge the{' '}
          <a href={routeHref({ name: 'docs', page: 'risks' })}>risks</a>.
        </p>
      </div>
    </>
  )
}
