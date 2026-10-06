import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { formatUnits, erc20Abi, type EIP1193Provider } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount, useConnect, useDisconnect, useReadContract, useSwitchChain, type Connector } from 'wagmi'
import { getChainId } from 'wagmi/actions'
import { wagmiConfig } from './wagmi'
import { ensureApiSession } from './lib/apiSession'
import { arc, polygon, ARC_USDC, ARC_USDC_DECIMALS, PUSD, PUSD_DECIMALS, BRAND, MIN_DEPOSIT_USDC, HAS_BUILDER_CODE, ONE_CLICK_TRADING, STORAGE } from './config'
import { checkGeoblock, type Access, type GeoResult } from './lib/geoblock'
import { getEvmDepositAddress } from './lib/polyBridge'
// The Polymarket SDK (~0.5 MB) loads on demand, when the user links or restores a session.
import type { PolyClient } from './lib/polyAccount'
import { clearCreds, loadCreds, saveCreds } from './lib/session'
import { Markets } from './components/Markets'
// Secondary pages load on first visit.
const Portfolio = lazy(() => import('./components/Portfolio').then((m) => ({ default: m.Portfolio })))
const WalletPage = lazy(() => import('./components/WalletPage').then((m) => ({ default: m.WalletPage })))
const Docs = lazy(() => import('./components/Docs').then((m) => ({ default: m.Docs })))
// Market pages (chart, order book, trades) load on first visit and are warmed up once the app is idle.
const loadMarketPage = () => import('./components/MarketPage')
const MarketPage = lazy(() => loadMarketPage().then((m) => ({ default: m.MarketPage })))
import { LiveAmount } from './components/LiveAmount'
import { LiveTicker } from './components/LiveTicker'
import { Backdrop } from './components/Backdrop'
import { ConnectModal, Header } from './components/Header'
import { Footer } from './components/Footer'
import { Toasts } from './components/Toasts'
import type { Blocker } from './components/TradePanel'
import { navigate, useRoute } from './lib/router'
import { backfill, setProgressAccount, track } from './lib/progress'
import { fetchPolymarketActivity, loadLocalActivity } from './lib/activity'
import { Quests, QuestNudge } from './components/Quests'
import { useAlertWatcher } from './lib/alerts'
import { usePositionWatcher } from './lib/watchers'
import { friendlyError } from './lib/toast'
import { applyHint, hintSettled, makeHint, type BalanceDelta, type Hint } from './lib/balanceHint'

type Theme = 'light' | 'dark'
// main.tsx applies the saved or system theme before first paint; start from that.
const initialTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

const TITLES: Record<string, string> = { markets: 'Markets', portfolio: 'Portfolio', wallet: 'Wallet', quests: 'Quests' }

export default function App() {
  const { address, connector, isConnected, chain, status: accountStatus } = useAccount()
  const { connect, connectors, isPending: connectPending } = useConnect()
  const route = useRoute()
  const [connectOpen, setConnectOpen] = useState(false)
  // The connector that actually holds the wallet session: the live one, or the matching instance
  // among discovered connectors when the account still carries a rehydrated placeholder.
  const liveConnector =
    connector && typeof connector.getProvider === 'function'
      ? connector
      : (connectors.find((c) => c.uid === connector?.uid) ?? connectors.find((c) => c.id === connector?.id))
  const hasLiveConnector = !!liveConnector && typeof liveConnector.getProvider === 'function'
  async function getProvider(): Promise<EIP1193Provider> {
    if (!liveConnector || typeof liveConnector.getProvider !== 'function') {
      throw new Error('Your wallet is still connecting. Wait a moment and try again.')
    }
    return (await liveConnector.getProvider()) as EIP1193Provider
  }
  const [connectError, setConnectError] = useState('')
  const { disconnect } = useDisconnect()
  const { switchChainAsync } = useSwitchChain()

  const [geo, setGeo] = useState<GeoResult | null>(null)
  const [geoError, setGeoError] = useState('')
  const [accountClosedOnly, setAccountClosedOnly] = useState(false)
  const [client, setClient] = useState<PolyClient | null>(null)
  const [polyWallet, setPolyWallet] = useState<`0x${string}` | null>(null)
  const [depositAddr, setDepositAddr] = useState<`0x${string}` | null>(null)
  const [tradingReady, setTradingReady] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [oneClick, setOneClick] = useState<{ client: PolyClient; validUntil: number; address: string } | null>(null)
  const [oneClickBusy, setOneClickBusy] = useState(false)
  // Price alerts and "you won" / "ending soon" notices, checked while the tab is open.
  useAlertWatcher()
  usePositionWatcher(polyWallet)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(STORAGE.theme, theme)
    } catch {
      // ignore
    }
  }, [theme])
  useEffect(() => {
    // Docs and market pages set their own titles.
    if (route.name !== 'docs' && route.name !== 'market') document.title = `${TITLES[route.name]} · ${BRAND.name}`
  }, [route.name])
  const [refreshKey, setRefreshKey] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const restoredFor = useRef<string | null>(null)
  // The account a running link flow belongs to; results for any other account are dropped.
  const currentAddress = useRef<string | undefined>(address)
  currentAddress.current = address
  // Poll balances fast for a few minutes after any action so changes show up as they land.
  const [liveUntil, setLiveUntil] = useState(0)
  const pollMs = liveUntil > Date.now() ? 3_000 : 10_000

  function runGeoCheck() {
    setGeoError('')
    checkGeoblock()
      .then(setGeo)
      .catch(() => setGeoError('Could not check your region (an ad blocker may be blocking polymarket.com).'))
  }

  useEffect(runGeoCheck, [])
  useEffect(() => {
    const warm = () => void loadMarketPage().catch(() => {})
    const id = setTimeout(warm, 2500)
    return () => clearTimeout(id)
  }, [])

  // Quest progress is kept per wallet (guest progress moves into the first wallet that connects).
  useEffect(() => {
    if (accountStatus === 'connected' && address) setProgressAccount(address)
    if (accountStatus === 'disconnected') setProgressAccount(undefined)
  }, [accountStatus, address])

  // Reset the Polymarket session when the wallet changes.
  useEffect(() => {
    setClient(null)
    setPolyWallet(null)
    setDepositAddr(null)
    setTradingReady(false)
    setNeedsSetup(false)
    setOneClick(null)
    setAccountClosedOnly(false)
  }, [address])

  // Restore a saved session after a reload without asking for a new signature.
  useEffect(() => {
    // Wait for wagmi to finish reconnecting: until then `connector` can be a stored placeholder
    // without methods (EIP-6963 wallets announce themselves a moment after page load).
    if (accountStatus !== 'connected' || !address || !hasLiveConnector || client || restoredFor.current === address) return
    if (!loadCreds(address)) return
    restoredFor.current = address
    linkPolymarket({ restore: true })
  }, [accountStatus, address, hasLiveConnector, client])

  // Until the region check succeeds, treat the user as close-only: they can manage existing
  // positions and withdraw, but cannot deposit or buy.
  const access: Access = geo
    ? accountClosedOnly && geo.access === 'open'
      ? 'close-only'
      : geo.access
    : 'close-only'

  const arcBalance = useReadContract({
    chainId: arc.id,
    address: ARC_USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: pollMs },
  })

  const pusdBalance = useReadContract({
    chainId: polygon.id,
    address: PUSD,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: polyWallet ? [polyWallet] : undefined,
    query: { enabled: !!polyWallet, refetchInterval: pollMs },
  })
  const pusdRaw = pusdBalance.data !== undefined ? formatUnits(pusdBalance.data, PUSD_DECIMALS) : null
  const arcRaw = arcBalance.data !== undefined ? formatUnits(arcBalance.data, ARC_USDC_DECIMALS) : null
  // Expected balances right after an action, shown until the chain read catches up (see lib/balanceHint).
  const [hints, setHints] = useState<{ pusd?: Hint; arc?: Hint }>({})
  // Hints belong to one wallet: drop them when the account (or its Polymarket wallet) changes.
  useEffect(() => setHints({}), [address, polyWallet])
  const pusd = applyHint(pusdRaw, hints.pusd)
  const arcUsdc = applyHint(arcRaw, hints.arc)
  useEffect(() => {
    if (!hints.pusd && !hints.arc) return
    const drop = () =>
      setHints((h) => ({
        pusd: h.pusd && !hintSettled(pusdRaw, h.pusd) ? h.pusd : undefined,
        arc: h.arc && !hintSettled(arcRaw, h.arc) ? h.arc : undefined,
      }))
    drop()
    const id = setInterval(drop, 5_000)
    return () => clearInterval(id)
  }, [pusdRaw, arcRaw, hints.pusd, hints.arc])
  const queryClient = useQueryClient()

  const refreshTimers = useRef<ReturnType<typeof setTimeout>[]>([])

  // Settlement lands on-chain a few seconds after an action and the Data API lags a bit more,
  // so refresh immediately and again shortly after.
  function refresh(delta?: BalanceDelta) {
    if (delta) {
      setHints((h) => ({
        pusd: (delta.pusd && makeHint(delta.pusd.before, delta.pusd.delta)) || h.pusd,
        arc: (delta.arc && makeHint(delta.arc.before, delta.arc.delta)) || h.arc,
      }))
    }
    setLiveUntil(Date.now() + 3 * 60_000)
    for (const t of refreshTimers.current) clearTimeout(t)
    refreshTimers.current = [0, 2_000, 5_000, 10_000, 20_000].map((ms) =>
      setTimeout(() => {
        // Every on-chain balance read, not only the two above (e.g. the top-up's source-chain balance).
        void queryClient.invalidateQueries({ queryKey: ['readContract'] })
        arcBalance.refetch()
        pusdBalance.refetch()
        setRefreshKey((k) => k + 1)
      }, ms),
    )
  }

  useEffect(() => () => refreshTimers.current.forEach(clearTimeout), [])

  // Run before anything the user signs for Polymarket: refreshes the signer session if needed, and
  // switches to Polygon because wallets reject EIP-712 payloads (chainId 137) on another chain.
  // The chain is read at call time; a deposit may have just moved the wallet to Arc.
  async function onPolygon() {
    await ensureApiSession()
    if (getChainId(wagmiConfig) !== polygon.id) await switchChainAsync({ chainId: polygon.id })
  }

  async function finishSetup(client: PolyClient, forAddress: string) {
    setError('')
    setStatus('Setting up your trading wallet (gasless)…')
    try {
      await onPolygon()
      const { ensureTradingReady } = await import('./lib/polyAccount')
      await ensureTradingReady(client)
      if (currentAddress.current !== forAddress) return
      setNeedsSetup(false)
      setTradingReady(true)
    } catch (e) {
      console.warn('[yaynay] trading setup failed:', e)
      setError(`Trading setup did not finish: ${friendlyError(e)}`)
    } finally {
      setStatus('')
    }
  }

  async function linkPolymarket({ restore = false } = {}) {
    if (!address || !hasLiveConnector) return
    const forAddress = address
    const stale = () => currentAddress.current !== forAddress
    setError('')
    const saved = loadCreds(address)
    let session: Awaited<ReturnType<typeof import('./lib/polyAccount').connectPolymarket>>
    try {
      if (!saved) {
        setStatus('Switching to Polygon to sign in…')
        await onPolygon()
        setStatus('Sign the Polymarket login message in your wallet (no gas)…')
      } else {
        setStatus('Restoring your Polymarket session…')
        await ensureApiSession()
      }
      const provider = await getProvider()
      const { connectPolymarket } = await import('./lib/polyAccount')
      session = await connectPolymarket({ provider, address, credentials: saved })
    } catch (e) {
      if (stale()) return
      setStatus('')
      const message = e instanceof Error ? e.message : String(e)
      if (restore) {
        console.warn('[yaynay] session restore failed:', e)
        // Only forget the saved session when Polymarket rejected the credentials themselves.
        if (/401|403|unauthor|invalid api key/i.test(message)) clearCreds(address)
        setError(`Could not restore your session (${friendlyError(e)}). Press Link to sign in again.`)
        return
      }
      setError(friendlyError(e))
      return
    }

    if (stale()) return
    saveCreds(address, session.client.credentials)
    track('account_linked')
    // Credit quests for what this wallet already did before quests existed (never lowers progress).
    fetchPolymarketActivity(session.wallet)
      .then((items) => {
        if (stale()) return
        const local = loadLocalActivity(forAddress)
        const count = (list: { kind: string }[], kind: string) => list.filter((i) => i.kind === kind).length
        backfill({
          trade_done: count(items, 'BUY'),
          sell_done: count(items, 'SELL'),
          claim_done: count(items, 'REDEEM'),
          deposit_done: count(local, 'DEPOSIT'),
          withdraw_done: count(local, 'WITHDRAW'),
        })
      })
      .catch((e) => console.warn('[yaynay] quest backfill failed:', e))
    setClient(session.client)
    setPolyWallet(session.wallet)
    setStatus('')
    if (ONE_CLICK_TRADING) {
      restoreOneClick(forAddress, session.wallet).catch((e) => console.warn('[yaynay] 1-click restore failed:', e))
    }

    // Secondary lookups must not tear down a working session.
    getEvmDepositAddress(session.wallet)
      .then((addr) => !stale() && setDepositAddr(addr))
      .catch((e) => console.warn('[yaynay] deposit address lookup failed:', e))
    session.client
      .fetchClosedOnlyMode()
      .then((closedOnly) => !stale() && setAccountClosedOnly(closedOnly))
      .catch((e) => console.warn('[yaynay] closed-only check failed:', e))
    try {
      const approvals = await session.client.fetchTradingApprovalsState()
      if (stale()) return
      if (approvals.isFullyApproved) {
        setTradingReady(true)
      } else if (restore) {
        // Never open wallet prompts on page load; wait for the user to click.
        setNeedsSetup(true)
      } else {
        await finishSetup(session.client, forAddress)
      }
    } catch (e) {
      console.warn('[yaynay] approvals check failed:', e)
      if (!stale()) setNeedsSetup(true)
    }
  }

  async function restoreOneClick(forAddress: string, wallet: string) {
    const { loadSessionKey, createSessionClient } = await import('./lib/sessionKey')
    const key = loadSessionKey(forAddress, wallet)
    if (!key) return
    const sessionClient = await createSessionClient(key, wallet)
    if (currentAddress.current === forAddress) setOneClick({ client: sessionClient, validUntil: key.validUntil, address: key.address })
  }

  async function toggleOneClick() {
    if (!client || !polyWallet || !address) return
    setError('')
    setOneClickBusy(true)
    try {
      const lib = await import('./lib/sessionKey')
      await onPolygon()
      if (oneClick) {
        const key = lib.loadSessionKey(address, polyWallet)
        if (key) await lib.disableOneClickTrading(client, address, polyWallet, key)
        setOneClick(null)
      } else {
        const { key, client: sessionClient } = await lib.enableOneClickTrading(client, address, polyWallet)
        setOneClick({ client: sessionClient, validUntil: key.validUntil, address: key.address })
      }
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setOneClickBusy(false)
    }
  }

  function signOut() {
    if (address) clearCreds(address)
    restoredFor.current = null
    disconnect()
  }

  const connectWallet = () => {
    setConnectError('')
    setConnectOpen(true)
  }
  const pickConnector = (c: Connector) =>
    connect(
      { connector: c, chainId: arc.id },
      {
        onSuccess: () => setConnectOpen(false),
        onError: (e) => setConnectError(friendlyError(e)),
      },
    )
  const linkAction = { label: 'Link Polymarket account', run: () => void linkPolymarket() }

  // Why the trade panel cannot place an order yet, with the next step.
  const blocker: Blocker | null = access === 'blocked'
    ? { text: 'Trading is not available in your region. You can browse markets only.' }
    : !isConnected
    ? { text: 'Connect a wallet that holds USDC on Arc to start trading.', action: { label: 'Connect wallet', run: connectWallet } }
    : !client
      ? { text: 'Link your Polymarket account: one signature, no gas.', action: linkAction }
      : needsSetup
        ? {
            text: 'Finish the one-time trading setup (gasless).',
            action: { label: 'Finish setup', run: () => address && void finishSetup(client, address) },
          }
        : !tradingReady
          ? { text: 'Setting up your trading wallet…' }
          : access !== 'open'
            ? { text: 'Buying is not available in your region. You can still sell positions and withdraw.' }
            : null


  return (
    <div className="app">
      <Backdrop />
      <LiveTicker />
      <Header
        route={route}
        theme={theme}
        onToggleTheme={() => {
          setTheme(theme === 'light' ? 'dark' : 'light')
          track('theme_switched')
        }}
        isConnected={isConnected}
        address={address}
        chainName={chain?.name}
        polyWallet={polyWallet}
        arcUsdc={arcUsdc}
        pusd={pusd}
        linked={!!client}
        linkDisabled={access === 'blocked' || !!status}
        onConnectClick={connectWallet}
        onLink={() => linkPolymarket()}
        onSignOut={signOut}
      />

      <main className="content" id="main" tabIndex={-1}>
        <div className="container">
          {geoError && (
            <div className="banner warn">
              <span className="grow">{geoError} Deposits and buying stay off until it succeeds.</span>
              <button className="ghost" onClick={runGeoCheck}>
                Retry
              </button>
            </div>
          )}
          {geo && access === 'close-only' && (
            <div className="banner warn">
              <span className="grow">
                Your region ({geo.country}
                {geo.region ? `-${geo.region}` : ''}) is close-only: you can sell, claim and withdraw, but not deposit or buy.
              </span>
            </div>
          )}
          {access === 'blocked' && (
            <div className="banner danger">
              <span className="grow">Trading is not available in your region.</span>
            </div>
          )}
          {status && (
            <div className="banner info" role="status">
              <span className="grow">⏳ {status}</span>
            </div>
          )}
          {error && (
            <div className="banner danger" role="alert">
              <span className="grow">{error}</span>
              <button className="link" onClick={() => setError('')}>
                Dismiss
              </button>
            </div>
          )}
          {needsSetup && client && !status && (
            <div className="banner info">
              <span className="grow">One more step: finish the gasless trading setup for your Polymarket wallet.</span>
              <button onClick={() => address && finishSetup(client, address)}>Finish setup</button>
            </div>
          )}

          {route.name === 'market' && (
            <Suspense fallback={<div className="skeleton" style={{ height: 560 }} />}>
              <MarketPage
                key={route.slug}
                slug={route.slug}
                marketId={route.marketId}
                side={route.side}
                client={tradingReady ? client : null}
                tradeClient={tradingReady ? (oneClick?.client ?? null) : null}
                canBuy={access === 'open'}
                blocker={blocker}
                pusdBalance={pusd}
                wallet={polyWallet}
                refreshKey={refreshKey}
                onPolygon={onPolygon}
                onTraded={refresh}
              />
            </Suspense>
          )}

          {/* The list stays mounted behind a market page so Back returns to the same filters and scroll. */}
          {(route.name === 'markets' || route.name === 'market') && (
            <div hidden={route.name === 'market'}>
              <Markets
                belowHero={<QuestNudge />}
                hero={
                  client ? (
                    <section className="card hero">
                      <div className="eyebrow accent">
                        <span className="live-dot" /> &nbsp;Welcome back
                      </div>
                      {Number(pusd ?? 0) >= 1 ? (
                        <>
                          <h1>
                            <em>${Number(pusd).toFixed(2)}</em> ready to trade.
                          </h1>
                          <p className="lead">Pick a market below, or top up from Arc in about a minute.</p>
                        </>
                      ) : Number(arcUsdc ?? 0) >= MIN_DEPOSIT_USDC ? (
                        <>
                          <h1>
                            Fund your next call from <em>Arc</em>.
                          </h1>
                          <p className="lead">
                            You have ${Number(arcUsdc).toFixed(2)} USDC on Arc. A deposit takes about a minute and needs no POL.
                          </p>
                        </>
                      ) : (
                        <>
                          <h1>
                            Call what <em>happens next</em>.
                          </h1>
                          <p className="lead">Add USDC to your Arc wallet, then deposit it here to start trading.</p>
                        </>
                      )}
                      <div className="facts">
                        <div>
                          <div className="eyebrow">Trading balance</div>
                          <div className="v num">
                            $<LiveAmount value={pusd} />
                          </div>
                        </div>
                        <div>
                          <div className="eyebrow">Arc wallet</div>
                          <div className="v num">
                            $<LiveAmount value={arcUsdc} />
                          </div>
                        </div>
                      </div>
                      <div className="actions">
                        <button onClick={() => navigate({ name: 'wallet' })}>Deposit from Arc</button>
                        <button className="ghost" onClick={() => navigate({ name: 'portfolio' })}>
                          View portfolio
                        </button>
                      </div>
                    </section>
                  ) : (
                    <section className="card hero">
                      <div className="eyebrow accent">
                        <span className="live-dot" /> &nbsp;Polymarket liquidity · built on Arc
                      </div>
                      <h1>
                        <span className="yay">Yay</span> or <span className="nay">nay</span>?
                      </h1>
                      <p className="lead">
                        Call what happens next with your USDC on Arc. Fund in about a minute, trade any Polymarket market,
                        and cash out back to Arc. You sign every step; we never hold your funds.
                      </p>
                      <div className="actions">
                        {!isConnected ? (
                          <button onClick={connectWallet}>Connect wallet</button>
                        ) : (
                          <button disabled={!!status} onClick={() => linkPolymarket()}>
                            Link Polymarket account
                          </button>
                        )}
                        <button className="ghost" onClick={() => navigate({ name: 'docs', page: 'how-it-works' })}>
                          How it works
                        </button>
                      </div>
                      <div className="facts">
                        <div>
                          <div className="eyebrow">Deposit</div>
                          <div className="v">Arc → Polymarket · ~1 min</div>
                        </div>
                        <div>
                          <div className="eyebrow">Withdraw</div>
                          <div className="v">Back to Arc · no POL</div>
                        </div>
                        <div>
                          <div className="eyebrow">Fees</div>
                          <div className="v">{BRAND.name} 0% · all costs shown</div>
                        </div>
                        <div>
                          <div className="eyebrow">Custody</div>
                          <div className="v">Non-custodial · you sign</div>
                        </div>
                      </div>
                    </section>
                  )
                }
              />
            </div>
          )}

          <Suspense fallback={<div className="skeleton" style={{ height: 420 }} />}>
          {route.name === 'portfolio' && (
            <Portfolio
              isConnected={isConnected}
              client={client}
              tradeClient={oneClick?.client ?? null}
              polyWallet={polyWallet}
              address={address}
              pusd={pusd}
              refreshKey={refreshKey}
              onConnect={connectWallet}
              onLink={() => linkPolymarket()}
              onPolygon={onPolygon}
              onChanged={refresh}
            />
          )}

          {route.name === 'wallet' && (
            <WalletPage
              isConnected={isConnected}
              address={address}
              client={client}
              polyWallet={polyWallet}
              depositAddress={depositAddr}
              canSign={hasLiveConnector}
              access={access}
              regionKnown={!!geo}
              arcUsdc={arcUsdc}
              pusd={pusd}
              getProvider={getProvider}
              switchToArc={() => switchChainAsync({ chainId: arc.id })}
              onConnect={connectWallet}
              onLink={() => linkPolymarket()}
              onPolygon={onPolygon}
              onDone={refresh}
              oneClick={
                tradingReady && ONE_CLICK_TRADING
                  ? { enabled: !!oneClick, validUntil: oneClick?.validUntil, busy: oneClickBusy, toggle: toggleOneClick }
                  : undefined
              }
            />
          )}

          {route.name === 'quests' && <Quests connected={isConnected} />}

          {route.name === 'docs' && <Docs page={route.page} />}
          </Suspense>

          {!HAS_BUILDER_CODE && <p className="muted" style={{ marginTop: 16 }}>Dev: VITE_BUILDER_CODE is not set; orders carry no builder code.</p>}
        </div>
      </main>

      <Footer />
      <Toasts />
      {connectOpen && (
        <ConnectModal
          connectors={connectors}
          error={connectError}
          pending={connectPending}
          onPick={pickConnector}
          onClose={() => setConnectOpen(false)}
        />
      )}
    </div>
  )
}
