import { useEffect, useState, type ReactNode } from 'react'
import type { EIP1193Provider } from 'viem'
import { BRAND, STORAGE, explorer, shortAddress, store } from '../config'
import type { Access } from '../lib/geoblock'
import type { PolyClient } from '../lib/polyAccount'
import { loadPendingWithdrawal } from '../lib/withdraw'
import { Deposit } from './Deposit'
import { LiveAmount } from './LiveAmount'
import { TopUp } from './TopUp'
import { Withdraw } from './Withdraw'
import '../styles/wallet.css'
import type { BalanceDelta } from '../lib/balanceHint'

const ONE_CLICK_HELP =
  'Sign once to authorize a trading-only key kept in this browser. Orders then go through without wallet ' +
  'pop-ups. The key cannot withdraw funds and expires after 180 days; turn it off at any time.'

type Dir = 'deposit' | 'withdraw'

/** The wallet page: deposit from Arc, withdraw to Arc, accounts and recovery help. */
export function WalletPage(props: {
  isConnected: boolean
  /** The user's Arc address. */
  address?: string
  client: PolyClient | null
  polyWallet: `0x${string}` | null
  /** Polymarket bridge deposit address for this wallet, once known. */
  depositAddress: `0x${string}` | null
  /** A live wallet connector is ready to sign (not a rehydrated placeholder). */
  canSign: boolean
  access: Access
  /** The region check has finished. */
  regionKnown: boolean
  arcUsdc: string | null
  pusd: string | null
  getProvider: () => Promise<EIP1193Provider>
  switchToArc: () => Promise<unknown>
  onConnect: () => void
  onLink: () => void
  onPolygon: () => Promise<void>
  onDone: (delta?: BalanceDelta) => void
  /** 1-click trading, when the feature flag is on and trading is set up. */
  oneClick?: { enabled: boolean; validUntil?: number; busy: boolean; cooling?: boolean; toggle: () => void }
  /** Tab requested by the URL (#/wallet?d=withdraw). */
  initialDir?: Dir
}) {
  const { address, client, polyWallet, access } = props
  // Open on the withdraw tab when a withdrawal (and no deposit) is still in flight from an earlier visit.
  const [dir, setDir] = useState<Dir>(
    () => props.initialDir ?? (address && loadPendingWithdrawal(address) && !store.get(STORAGE.pendingDeposit) ? 'withdraw' : 'deposit'),
  )
  useEffect(() => {
    if (props.initialDir) setDir(props.initialDir)
  }, [props.initialDir])

  const canDeposit = props.canSign && !!props.depositAddress && access === 'open'
  const canWithdraw = !!(client && polyWallet && address && access !== 'blocked')

  // The next thing the user has to do before money can move.
  const nextStep: ReactNode = !props.isConnected ? (
    <button onClick={props.onConnect}>Connect wallet</button>
  ) : !client ? (
    <button onClick={props.onLink}>Link account</button>
  ) : null

  return (
    <div className="wl-page">
      <div className="section-head">
        <div>
          <span className="eyebrow accent">Arc ⇄ Polymarket</span>
          <h1>Wallet</h1>
          <p className="section-sub">Move USDC between Arc and your trading balance. No POL, and you sign every step.</p>
        </div>
        <span className="wl-trust">
          <ShieldIcon /> Non-custodial · funds stay in your wallets
        </span>
      </div>

      <BridgeHero
        dir={dir}
        connected={props.isConnected}
        arcUsdc={props.arcUsdc}
        pusd={props.pusd}
        address={address}
        polyWallet={polyWallet}
      />

      <div className="wl-grid">
        <div className="tu-col">
          <section className="card wl-transfer" aria-label="Move money">
            <div className="wl-tabs" role="tablist" aria-label="Direction">
              <button
                role="tab"
                id="wl-tab-deposit"
                aria-controls="wl-panel-deposit"
                aria-selected={dir === 'deposit'}
                className={dir === 'deposit' ? 'on' : ''}
                onClick={() => setDir('deposit')}
              >
                <span aria-hidden="true">↓</span> Deposit
              </button>
              <button
                role="tab"
                id="wl-tab-withdraw"
                aria-controls="wl-panel-withdraw"
                aria-selected={dir === 'withdraw'}
                className={dir === 'withdraw' ? 'on' : ''}
                onClick={() => setDir('withdraw')}
              >
                <span aria-hidden="true">↑</span> Withdraw
              </button>
            </div>

            {/* Both flows stay mounted so a transfer in progress keeps tracking while the other tab is open. */}
            <div role="tabpanel" id="wl-panel-deposit" aria-labelledby="wl-tab-deposit" hidden={dir !== 'deposit'}>
              {canDeposit && props.depositAddress ? (
                <Deposit
                  getProvider={props.getProvider}
                  depositAddress={props.depositAddress}
                  arcAddress={address ?? ''}
                  arcBalance={props.arcUsdc}
                  pusdBalance={props.pusd}
                  switchToArc={props.switchToArc}
                  onDone={props.onDone}
                />
              ) : access !== 'open' && props.regionKnown ? (
                <Gate tone="warn" title="Deposits are paused here" action={nextStep}>
                  Deposits are not available in your region.
                  {access === 'close-only' && ' You can still withdraw and close positions.'}
                </Gate>
              ) : !props.isConnected ? (
                <Gate title="Yay, let's fund it" action={nextStep}>
                  Connect a wallet and link your Polymarket account to deposit. Your USDC on Arc lands as pUSD in about a minute.
                </Gate>
              ) : !client ? (
                <Gate title="One more step: link Polymarket" action={nextStep}>
                  Link your Polymarket account so we know which wallet to fund. You sign it; we never hold your keys or funds.
                </Gate>
              ) : (
                <Gate
                  title="Getting your deposit address"
                  action={
                    !props.canSign ? (
                      <button className="ghost" onClick={props.onConnect}>
                        Reconnect wallet
                      </button>
                    ) : null
                  }
                >
                  Waiting for your wallet and your Polymarket deposit address. If this takes more than a few seconds,
                  reconnect your wallet.
                </Gate>
              )}
            </div>
            <div role="tabpanel" id="wl-panel-withdraw" aria-labelledby="wl-tab-withdraw" hidden={dir !== 'withdraw'}>
              {canWithdraw && client && polyWallet && address ? (
                <Withdraw
                  client={client}
                  wallet={polyWallet}
                  arcRecipient={address}
                  pusdBalance={props.pusd}
                  arcBalance={props.arcUsdc}
                  onPolygon={props.onPolygon}
                  onDone={props.onDone}
                />
              ) : access === 'blocked' && props.regionKnown ? (
                <Gate tone="warn" title="Withdrawals are paused here" action={nextStep}>
                  Withdrawals are not available in your region from this app.
                </Gate>
              ) : (
                <Gate title="Cash out to Arc" action={nextStep}>
                  Your Polymarket balance comes back to Arc as USDC, with no POL needed.
                  {!props.isConnected
                    ? ' Connect your wallet to start.'
                    : !client
                      ? ' Link your Polymarket account to start.'
                      : ''}
                </Gate>
              )}
            </div>
          </section>

          {/* Secondary: bring funds to Arc from other chains; the Arc deposit above stays primary. */}
          <TopUp
            key={address ?? 'none'}
            address={address}
            isConnected={props.isConnected}
            canSign={props.canSign}
            getProvider={props.getProvider}
            onConnect={props.onConnect}
            onDone={props.onDone}
          />
        </div>

        <div className="wl-side">
          <Accounts
            address={address}
            polyWallet={polyWallet}
            depositAddress={props.depositAddress}
            oneClick={props.oneClick}
          />
          <Pending polyWallet={polyWallet} />
        </div>
      </div>

      <HowItWorks />
    </div>
  )
}

/** Respects the OS "reduce motion" setting for the SVG particles (SMIL ignores CSS media queries). */
function useReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduce, setReduce] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia(query)
    const on = () => setReduce(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return reduce
}

// A gentle wave; the three middle stops sit on it at x = 150, 300 and 450.
const ROUTE = 'M0 40 C50 12 100 12 150 40 S250 68 300 40 S400 12 450 40 S550 68 600 40'
const STOPS: Record<Dir, string[]> = {
  deposit: ['Circle CCTP', 'Polygon', 'PM bridge'],
  withdraw: ['Relay', 'Polygon', 'PM bridge'],
}
const PARTICLES = 5
const LOOP_S = 4

/** Arc balance on the left, trading balance on the right, money flowing between them. */
function BridgeHero(p: {
  dir: Dir
  connected: boolean
  arcUsdc: string | null
  pusd: string | null
  address?: string
  polyWallet: string | null
}) {
  const reduce = useReducedMotion()
  const forward = p.dir === 'deposit'
  return (
    <section className={`card wl-bridge ${p.dir}`} aria-label="Balances">
      <div className="wl-node arc">
        <span className="wl-chain">
          <img className="wl-chain-logo" src="/brands/arc.png" alt="" width={26} height={26} /> Arc
        </span>
        <span className="eyebrow">USDC on Arc</span>
        <span className={`wl-bal num ${p.connected ? '' : 'wl-bal-empty'}`}>{p.connected ? <LiveAmount value={p.arcUsdc} /> : '—'}</span>
        <span className="wl-node-foot mono">{p.address ? shortAddress(p.address) : 'not connected'}</span>
      </div>

      <div className="wl-route">
        <div className="wl-route-cap">
          {forward ? 'Deposit · about 1 minute' : 'Withdraw · one gasless signature'}
          <span className="wl-route-arrow" aria-hidden="true">{forward ? '→' : '←'}</span>
        </div>
        <div className="wl-route-art">
          <svg viewBox="0 0 600 80" aria-hidden="true" focusable="false">
            <path className="wl-route-track" d={ROUTE} />
            <path className={`wl-route-flow ${reduce ? '' : 'moving'}`} d={ROUTE} />
            <circle className="wl-end" cx="0" cy="40" r="5" />
            <circle className="wl-end" cx="600" cy="40" r="5" />
            {[150, 300, 450].map((x) => (
              <circle key={x} className="wl-stop" cx={x} cy="40" r="7" />
            ))}
            {!reduce && (
              <g key={p.dir}>
                {Array.from({ length: PARTICLES }, (_, i) => (
                  <g key={i} className={`wl-candle c${i % 2}`} opacity="0">
                    <line x1="0" y1="-10" x2="0" y2="10" />
                    <rect x="-3.5" y="-6" width="7" height="12" rx="1.6" />
                    <animateMotion
                      dur={`${LOOP_S}s`}
                      begin={`${(-i * LOOP_S) / PARTICLES}s`}
                      repeatCount="indefinite"
                      calcMode="linear"
                      keyPoints={forward ? '0;1' : '1;0'}
                      keyTimes="0;1"
                      path={ROUTE}
                    />
                    <animate
                      attributeName="opacity"
                      dur={`${LOOP_S}s`}
                      begin={`${(-i * LOOP_S) / PARTICLES}s`}
                      repeatCount="indefinite"
                      values="0;1;1;0"
                      keyTimes="0;0.08;0.92;1"
                    />
                  </g>
                ))}
              </g>
            )}
          </svg>
          <div className="wl-route-labels" aria-hidden="true">
            {STOPS[p.dir].map((s, i) => (
              <span key={s} style={{ left: `${(i + 1) * 25}%` }}>
                {s}
              </span>
            ))}
          </div>
        </div>
        <p className="wl-sr">
          {forward
            ? 'Deposit route: Arc, Circle CCTP, Polygon, Polymarket bridge, trading balance.'
            : 'Withdraw route: trading balance, Polymarket bridge, Polygon, Relay, Arc.'}
        </p>
      </div>

      <div className="wl-node pm">
        <span className="wl-chain">
          <img className="wl-chain-logo" src="/brands/polymarket.png" alt="" width={26} height={26} /> Polymarket
        </span>
        <span className="eyebrow">Trading balance</span>
        <span className={`wl-bal num ${p.connected ? '' : 'wl-bal-empty'}`}>{p.connected ? <LiveAmount value={p.pusd} /> : '—'}</span>
        <span className="wl-node-foot mono">{p.polyWallet ? `pUSD · ${shortAddress(p.polyWallet)}` : 'pUSD'}</span>
      </div>
    </section>
  )
}

/** Empty / blocked state inside a transfer tab. */
function Gate(p: { title: string; children: ReactNode; action?: ReactNode; tone?: 'warn' }) {
  return (
    <div className={`wl-gate ${p.tone ?? ''}`}>
      <svg className="wl-gate-art" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
        <line x1="22" y1="10" x2="22" y2="54" className="wick yes" />
        <rect x="15" y="20" width="14" height="24" rx="3" className="body yes" />
        <line x1="42" y1="14" x2="42" y2="50" className="wick no" />
        <rect x="35" y="26" width="14" height="16" rx="3" className="body no" />
      </svg>
      <h2>{p.title}</h2>
      <p className="sub">{p.children}</p>
      {p.action && <div className="wl-gate-action">{p.action}</div>}
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])
  return (
    <button
      className="wl-icon-btn"
      title={copied ? 'Copied' : `Copy ${label}`}
      aria-label={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {})}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
    </button>
  )
}

function ExplorerLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="wl-icon-btn" href={href} target="_blank" rel="noreferrer" title={label} aria-label={label}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-3M9.5 2H14v4.5M14 2 7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  )
}

function AddressRow(p: { label: string; hint: string; value: string | null | undefined; href?: string; explorerName: string }) {
  return (
    <div className="wl-acct-row">
      <div className="wl-acct-k">
        <span>{p.label}</span>
        <small>{p.hint}</small>
      </div>
      {p.value ? (
        <div className="wl-acct-v">
          <span className="mono">{shortAddress(p.value)}</span>
          <CopyButton value={p.value} label={p.label} />
          {p.href && <ExplorerLink href={p.href} label={`View on ${p.explorerName}`} />}
        </div>
      ) : (
        <span className="muted">—</span>
      )}
    </div>
  )
}

function Accounts(p: {
  address?: string
  polyWallet: string | null
  depositAddress: string | null
  oneClick?: { enabled: boolean; validUntil?: number; busy: boolean; cooling?: boolean; toggle: () => void }
}) {
  return (
    <section className="card wl-accounts">
      <h2>Accounts</h2>
      <p className="sub">Everything stays in wallets you control.</p>
      <AddressRow
        label="Arc wallet"
        hint="Signs deposits; receives withdrawals"
        value={p.address}
        href={p.address ? explorer.arcAddress(p.address) : undefined}
        explorerName="Arc explorer"
      />
      <AddressRow
        label="Polymarket wallet"
        hint={p.polyWallet ? 'Holds your pUSD and positions' : 'Link your account to see it'}
        value={p.polyWallet}
        href={p.polyWallet ? explorer.polygonAddress(p.polyWallet) : undefined}
        explorerName="Polygonscan"
      />
      {p.depositAddress && (
        <AddressRow
          label="Deposit address"
          hint="Polymarket bridge, on Polygon"
          value={p.depositAddress}
          href={explorer.polygonAddress(p.depositAddress)}
          explorerName="Polygonscan"
        />
      )}
      {p.oneClick && (
        <div className={`wl-oneclick ${p.oneClick.enabled ? 'on' : ''}`}>
          <div>
            <div className="wl-oneclick-title" title={ONE_CLICK_HELP}>
              <span aria-hidden="true">⚡</span> 1-click trading
              <span className="wl-pill">
                {p.oneClick.enabled && p.oneClick.validUntil
                  ? `on until ${new Date(p.oneClick.validUntil * 1000).toLocaleDateString()}`
                  : 'off'}
              </span>
            </div>
            <p className="wl-fineprint">{ONE_CLICK_HELP}</p>
          </div>
          <button className="subtle" disabled={p.oneClick.busy} onClick={p.oneClick.toggle}>
            {p.oneClick.cooling ? 'Finishing… (~1 min)' : p.oneClick.busy ? 'working…' : p.oneClick.enabled ? 'Turn off' : 'Enable'}
          </button>
        </div>
      )}
    </section>
  )
}

function Pending({ polyWallet }: { polyWallet: string | null }) {
  return (
    <section className="card wl-faq">
      <h2>Something pending?</h2>
      <p className="sub">Every step is an on-chain transaction you can check yourself.</p>
      <details>
        <summary>Deposit stuck after the Arc burn</summary>
        <p>Circle usually mints within a minute; the stepper resumes after a reload.</p>
      </details>
      <details>
        <summary>Minted but no pUSD yet</summary>
        <p>
          Polymarket's bridge credits in ~30 s. If not, use{' '}
          <a href="https://recovery.polymarket.com" target="_blank" rel="noreferrer">
            recovery.polymarket.com
          </a>
          .
        </p>
      </details>
      <details>
        <summary>Withdrawal not on Arc</summary>
        <p>Relay delivers in seconds; if it can't, it refunds USDC to your address on Polygon.</p>
      </details>
      <div className="wl-faq-foot">
        <span className="k">Your Polymarket wallet</span>
        {polyWallet ? (
          <a href={`${explorer.polygonAddress(polyWallet)}#tokentxns`} target="_blank" rel="noreferrer">
            View all transfers ↗
          </a>
        ) : (
          <span className="muted">Link your account to see it</span>
        )}
      </div>
    </section>
  )
}

const HOW: { title: string; text: string; glyph: ReactNode }[] = [
  {
    title: 'Leave Arc',
    text: 'Your USDC leaves Arc through Circle CCTP; Circle mints it on Polygon for you.',
    glyph: <path d="M4 12h12M12 7l5 5-5 5" />,
  },
  {
    title: 'Become pUSD',
    text: "Polymarket's bridge converts it to pUSD in your own Polymarket wallet.",
    glyph: <path d="M5 9h11l-3-3M19 15H8l3 3" />,
  },
  {
    title: 'Trade',
    text: `You trade; orders are signed in your wallet and carry the ${BRAND.name} builder code.`,
    glyph: (
      <>
        <path d="M8 4v16M16 6v12" />
        <rect x="6" y="8" width="4" height="7" rx="1" />
        <rect x="14" y="9" width="4" height="5" rx="1" />
      </>
    ),
  },
  {
    title: 'Come home',
    text: "Withdrawals return to your Arc address as USDC via Polymarket's bridge and Relay.",
    glyph: <path d="M20 12H8M12 7l-5 5 5 5" />,
  },
]

function HowItWorks() {
  return (
    <section className="card wl-how">
      <div className="wl-how-head">
        <div>
          <h2>How it works</h2>
          <p className="sub">Arc ↔ Polymarket in one flow.</p>
        </div>
      </div>
      <ol className="wl-how-steps">
        {HOW.map((h, i) => (
          <li key={h.title}>
            <span className="wl-how-ico" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {h.glyph}
              </svg>
            </span>
            <span className="eyebrow">Step {i + 1}</span>
            <b>{h.title}</b>
            <p>{h.text}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 13.5 3.5v4c0 3.2-2.3 5.9-5.5 7-3.2-1.1-5.5-3.8-5.5-7v-4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m5.5 8 1.8 1.8L10.8 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
