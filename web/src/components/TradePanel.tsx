import { addPendingFill } from '../lib/pendingFills'
import { useEffect, useRef, useState } from 'react'
import { roundToTick, type Outcome } from '../lib/markets'
import { fetchAsks, fetchFeeParams, maxAffordableSpend, quoteBuy, type FeeParams, type Level } from '../lib/quote'
import type { PolyClient } from '../lib/polyAccount'
import { ensureApiSession } from '../lib/apiSession'
import type { Pick } from './EventCard'
import { Sparkline } from './Sparkline'
import { endsLabel, multiplier } from './format'
import { BRAND, explorer } from '../config'
import { friendlyError, toast } from '../lib/toast'
import type { BalanceDelta } from '../lib/balanceHint'

// Below 3¢ the buyer very likely loses; at 95¢+ they risk 95¢ to make 5¢ (the biggest source of
// losses in user reports). Both need an explicit acknowledgement.
const NEAR_CERTAIN_LOW = 0.03
const NEAR_CERTAIN_HIGH = 0.95
// Warn when the order eats into the book by more than this over the best ask.
const IMPACT_WARN = 0.03
const PRESETS = [1, 5, 10, 25]

type Status = { text: string; kind: 'info' | 'ok' | 'err' }

/** Why the user cannot place an order yet, with the next step. */
export type Blocker = { text: string; action?: { label: string; run: () => void } }

export function TradePanel(props: {
  pick: Pick
  client: PolyClient | null
  /** 1-click trading session client; orders signed without wallet prompts when set. */
  tradeClient: PolyClient | null
  canBuy: boolean
  /** Shown instead of the buy button when the user cannot trade yet. */
  blocker: Blocker | null
  pusdBalance: string | null
  onPolygon: () => Promise<void>
  onTraded: (delta?: BalanceDelta) => void
  onClose?: () => void
  /** 'drawer' slides over the page as a dialog; 'dock' sits inside the market page. */
  variant?: 'drawer' | 'dock'
  onOutcomeChange?: (outcome: Outcome) => void
  /** 1-click trading switch, when the feature is available; offered quietly under the buy button. */
  oneClick?: { enabled: boolean; busy: boolean; toggle: () => void }
}) {
  const { event, market } = props.pick
  const dock = props.variant === 'dock'
  const [outcome, setOutcomeState] = useState<Outcome>(props.pick.outcome)
  const setOutcome = (o: Outcome) => {
    setOutcomeState(o)
    props.onOutcomeChange?.(o)
  }
  // The page may pick another side (e.g. a "No" button in the outcome list).
  const pickedToken = props.pick.outcome.tokenId
  useEffect(() => {
    setOutcomeState(props.pick.outcome)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedToken])
  const [amount, setAmount] = useState('5')
  const [book, setBook] = useState<{ tokenId: string; asks: Level[]; fee: FeeParams } | null>(null)
  const [bookError, setBookError] = useState('')
  const [ack, setAck] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setAck(false)
    setBookError('')
    Promise.all([fetchAsks(outcome.tokenId), fetchFeeParams(market.conditionId)])
      .then(([asks, fee]) => !cancelled && setBook({ tokenId: outcome.tokenId, asks, fee }))
      .catch((e) => !cancelled && setBookError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [outcome.tokenId, market.conditionId])

  // Dialog behaviour: focus the amount on open, keep Tab inside, Escape closes, focus returns to
  // the button that opened the panel, and the page behind does not scroll.
  const panel = useRef<HTMLElement>(null)
  const amountInput = useRef<HTMLInputElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  useEffect(() => {
    if (dock) return
    const previous = document.activeElement as HTMLElement | null
    amountInput.current?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose.current?.()
      if (e.key !== 'Tab' || !panel.current) return
      const focusable = panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, summary')
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      previous?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const spend = Number(amount)
  const quote = book?.tokenId === outcome.tokenId && spend > 0 ? quoteBuy(book.asks, spend, book.fee) : null
  const nearCertain = !!quote && (quote.avgPrice < NEAR_CERTAIN_LOW || quote.avgPrice > NEAR_CERTAIN_HIGH)
  const thinBook = !!quote && quote.filledUsd < spend - 0.005
  const noSellers = book?.tokenId === outcome.tokenId && book.asks.length === 0
  const isFirst = outcome.tokenId === market.outcomes[0].tokenId
  const bestAsk = book?.tokenId === outcome.tokenId ? book.asks[0]?.price : undefined
  const impact = quote && bestAsk ? quote.avgPrice / bestAsk - 1 : 0
  const priceNow = bestAsk ?? outcome.price
  const profit = quote ? quote.shares - quote.filledUsd - quote.fee : 0

  async function submit() {
    const pusdBefore = props.pusdBalance
    if (!props.client || !quote) return
    setBusy(true)
    try {
      const { buy, tradingBalance } = await import('../lib/trade')
      // Re-quote against the current book; prices may have moved since the panel opened.
      setStatus({ text: 'Checking the latest prices and your balance…', kind: 'info' })
      const asks = await fetchAsks(outcome.tokenId)
      const fresh = book ? quoteBuy(asks, spend, book.fee) : null
      if (!fresh) {
        setStatus({ text: `No sellers for ${outcome.name} right now.`, kind: 'err' })
        return
      }
      const limit = roundToTick(Math.min(1 - market.tickSize, fresh.worstPrice + 2 * market.tickSize), market.tickSize)
      // Also refreshes the CLOB's cached balance so a recent deposit or sale is counted.
      const balance = await tradingBalance(props.client)
      const needed = fresh.filledUsd + fresh.fee
      if (balance + 1e-6 < needed) {
        setStatus({
          text: `Not enough pUSD: you have ${balance.toFixed(2)}, this order needs ≈ ${needed.toFixed(2)} including the fee. Lower the amount or deposit from Arc.`,
          kind: 'err',
        })
        return
      }
      const owner = props.client
      if (props.tradeClient) {
        await ensureApiSession()
        setStatus({ text: 'Placing your order…', kind: 'info' })
      } else {
        await props.onPolygon()
        setStatus({ text: 'Confirm the order in your wallet…', kind: 'info' })
      }
      const signers = { trade: props.tradeClient ?? owner, owner, prepareOwner: props.onPolygon }
      const res = await buy(signers, { tokenId: outcome.tokenId, amountUsd: amount, maxPrice: limit }, (text) =>
        setStatus({ text, kind: 'info' }),
      )
      const summary = `Bought ${Number(res.takingAmount).toFixed(2)} ${outcome.name} shares for $${Number(res.makingAmount).toFixed(2)}.`
      if (Number(res.takingAmount) > 0) {
        // Shown on the market page at once; Polymarket's position data catches up within about a minute.
        addPendingFill({
          asset: outcome.tokenId,
          conditionId: market.conditionId,
          outcome: outcome.name,
          title: market.question,
          shares: Number(res.takingAmount),
          cost: Number(res.makingAmount),
          at: Date.now(),
        })
      }
      setStatus({ text: summary, kind: 'ok' })
      const txHash = res.transactionsHashes?.[0]
      toast({
        kind: 'success',
        title: 'Call placed',
        detail: `${summary} ${event.title}`,
        href: txHash ? explorer.polygonTx(txHash) : undefined,
        linkLabel: 'View on Polygon',
      })
      props.onTraded(Number(res.makingAmount) > 0 ? { pusd: { delta: -Number(res.makingAmount), before: pusdBefore } } : undefined)
    } catch (e) {
      setStatus({ text: friendlyError(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  const body = (
        <div className="panel-body">
          <div className="seg">
            {market.outcomes.slice(0, 2).map((o, i) => (
              <button
                key={o.tokenId}
                className={o.tokenId === outcome.tokenId ? (i === 0 ? 'on-yes' : 'on-no') : ''}
                aria-pressed={o.tokenId === outcome.tokenId}
                onClick={() => setOutcome(o)}
              >
                {o.name} {(o.price * 100).toFixed(o.price < 0.1 ? 1 : 0)}¢
                <small>pays {multiplier(o.price)}</small>
              </button>
            ))}
          </div>

          <div className="explain">
            {(priceNow * 100).toFixed(priceNow < 0.1 ? 1 : 0)}¢ means the market gives <b>{outcome.name}</b> about a{' '}
            {Math.round(priceNow * 100)}% chance. Each share pays <b>$1</b> if it happens and $0 if not.
          </div>
          {!dock && <Sparkline tokenId={outcome.tokenId} interval="1w" height={70} className="spark small" />}

          <div className="amount-box">
            <div className="row">
              <span>Amount (pUSD)</span>
              {props.pusdBalance !== null && (
                <button
                  className="link"
                  title="Fill the most you can spend, leaving room for Polymarket's fee"
                  onClick={() => {
                    const balance = Math.floor(Number(props.pusdBalance) * 100) / 100
                    const max = book?.tokenId === outcome.tokenId ? maxAffordableSpend(book.asks, balance, book.fee) : balance
                    setAmount(String(max))
                  }}
                >
                  Balance {Number(props.pusdBalance).toFixed(2)}
                </button>
              )}
            </div>
            <input
              ref={amountInput}
              id={dock ? 'trade-amount-dock' : 'trade-amount'}
              aria-label="Amount in pUSD"
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim())}
              inputMode="decimal"
              placeholder="0"
            />
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p} onClick={() => setAmount(String(p))}>
                  ${p}
                </button>
              ))}
            </div>
          </div>

          {bookError && <div className="notice err">{bookError}</div>}
          {noSellers && <div className="notice err">No sellers for {outcome.name} right now.</div>}

          {quote && (
            <div className="summary">
              <div className="line">
                <span>Avg price</span>
                <strong className="num">{(quote.avgPrice * 100).toFixed(2)}¢</strong>
              </div>
              <div className="line">
                <span>Shares</span>
                <strong className="num">{quote.shares.toFixed(2)}</strong>
              </div>
              <div className="line">
                <span>Polymarket fee</span>
                <strong className="num">${quote.fee.toFixed(3)}</strong>
              </div>
              <div className="line">
                <span>{BRAND.name} fee</span>
                <strong className="num">$0.00</strong>
              </div>
              <div className="line total">
                <span>Total</span>
                <strong className="num">${(quote.filledUsd + quote.fee).toFixed(2)}</strong>
              </div>
              <div className="line win">
                <span>Payout if {outcome.name} wins</span>
                <strong className="num">
                  ${quote.shares.toFixed(2)} ({profit >= 0 ? '+' : '−'}${Math.abs(profit).toFixed(2)})
                </strong>
              </div>
            </div>
          )}
          {thinBook && <div className="notice warn">Only ${quote!.filledUsd.toFixed(2)} is available at current prices.</div>}
          {impact > IMPACT_WARN && (
            <div className="notice warn">
              This order moves the price: you pay {(quote!.avgPrice * 100).toFixed(1)}¢ on average versus{' '}
              {(bestAsk! * 100).toFixed(1)}¢ best ask (+{(impact * 100).toFixed(1)}%). A smaller amount fills closer to the
              quoted price.
            </div>
          )}
          {quote && quote.shares < market.minSize && (
            <div className="notice info">
              You would get {quote.shares.toFixed(2)} shares. Polymarket's minimum order is {market.minSize} shares, so a
              position this small may be hard to sell before the market resolves (you can still hold it to the end).
            </div>
          )}

          {nearCertain && (
            <div className="notice warn">
              <label>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>
                  {quote!.avgPrice < NEAR_CERTAIN_LOW
                    ? `${outcome.name} trades at ${(quote!.avgPrice * 100).toFixed(1)}¢: the market thinks it almost certainly won't happen. You will very likely lose this amount.`
                    : `You risk ${(quote!.avgPrice * 100).toFixed(0)}¢ to make ${(100 - quote!.avgPrice * 100).toFixed(0)}¢ per share. If the unlikely outcome happens, you lose the whole amount.`}{' '}
                  I understand.
                </span>
              </label>
            </div>
          )}

          {props.blocker ? (
            <div className="notice info">
              {props.blocker.text}
              {props.blocker.action && (
                <div style={{ marginTop: 10 }}>
                  <button onClick={props.blocker.action.run}>{props.blocker.action.label}</button>
                </div>
              )}
            </div>
          ) : (
            <button
              className={`block ${isFirst ? 'yes' : 'no'}`}
              disabled={!props.canBuy || !quote || busy || (nearCertain && !ack)}
              onClick={submit}
            >
              {busy
                ? 'Working…'
                : `${props.tradeClient ? '⚡ ' : ''}${quote ? `Buy ${outcome.name} · $${(quote.filledUsd + quote.fee).toFixed(2)}` : `Buy ${outcome.name}`}`}
            </button>
          )}

          {props.oneClick && !props.oneClick.enabled && props.client && !props.blocker && (
            <div className="oneclick-hint">
              <span>
                <span aria-hidden="true">⚡</span> Skip the wallet pop-up on every trade.
              </span>
              <button type="button" className="link" disabled={props.oneClick.busy} onClick={props.oneClick.toggle}>
                {props.oneClick.busy ? 'Turning on…' : 'Turn on 1-click'}
              </button>
            </div>
          )}

          {status && (
            <div className={`notice ${status.kind}`} role={status.kind === 'err' ? 'alert' : 'status'}>
              {status.text}
            </div>
          )}

          {!dock && (
            <details className="rules">
              <summary>Rules &amp; resolution</summary>
              <p>
                {market.endDate && <>{endsLabel(market.endDate)}. </>}
                {market.description || 'See the full rules on Polymarket.'}
                {market.resolutionSource && `\n\nResolution source: ${market.resolutionSource}`}
                {'\n\n'}Polymarket resolves markets through the UMA optimistic oracle. After a result is proposed there is a
                2-hour challenge window; disputed results can take a few more days.
              </p>
            </details>
          )}
          <p className="muted">
            Market order (fill-and-kill) capped 2 ticks above the current book, so you never pay more than shown. {props.tradeClient ? 'Signed with your 1-click key (trading only, cannot withdraw)' : 'Signed in your wallet'} and routed to Polymarket with the {BRAND.name} builder code, which attributes the volume to us and
            does not change your price. {BRAND.name} charges no fee.
          </p>
        </div>
  )

  if (dock) {
    return (
      <aside className="panel dock" aria-label={`Trade ${market.label}`}>
        <div className="dock-head">
          <span className="eyebrow">Make your call</span>
          {event.markets.length > 1 && <div className="dock-title">{market.label}</div>}
        </div>
        {body}
      </aside>
    )
  }

  return (
    <>
      <div className="overlay" onClick={props.onClose} aria-hidden="true" />
      <aside className="panel" role="dialog" aria-modal="true" aria-label={`Trade ${event.title}`} ref={panel}>
        <div className="panel-head">
          {event.image ? <img className="event-img" src={event.image} alt="" /> : <div className="event-img" />}
          <div>
            <div className="event-title">{event.title}</div>
            {event.markets.length > 1 && <div className="event-meta">{market.label}</div>}
          </div>
          <button className="close" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        {body}
      </aside>
    </>
  )
}
