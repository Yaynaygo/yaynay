import { useEffect, useRef, useState } from 'react'
import { parseUnits } from 'viem'
import {
  getRelayRouteToArc,
  loadPendingWithdrawal,
  savePendingWithdrawal,
  trackWithdrawal,
  withdrawToArc,
  type PendingWithdrawal,
  type WithdrawProgress,
} from '../lib/withdraw'
import { AMOUNT_RE, MIN_WITHDRAW_PUSD, PUSD_DECIMALS, explorer } from '../config'
import type { PolyClient } from '../lib/polyAccount'
import { recordActivity } from '../lib/activity'
import { friendlyError, toast } from '../lib/toast'
import { Stepper, type Step } from './Stepper'
import { track } from '../lib/progress'
import type { BalanceDelta } from '../lib/balanceHint'

export function Withdraw(props: {
  client: PolyClient
  wallet: string
  arcRecipient: string
  pusdBalance: string | null
  /** Arc balance now, so the arrival can be shown before the chain read catches up. */
  arcBalance?: string | null
  onPolygon: () => Promise<void>
  /** Called when pUSD leaves and when USDC lands on Arc, with the expected balance change. */
  onDone: (delta?: BalanceDelta) => void
}) {
  const [amount, setAmount] = useState('')
  const [steps, setSteps] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<PendingWithdrawal | null>(() => loadPendingWithdrawal(props.arcRecipient))
  const [progress, setProgress] = useState<WithdrawProgress | null>(null)
  // The parent's callback changes every render; tracking must not restart because of it.
  const onDone = useRef(props.onDone)
  onDone.current = props.onDone
  const toastId = useRef<number | undefined>(undefined)
  // Latest Arc balance, read when the withdrawal lands (the tracker outlives renders).
  const arcNow = useRef(props.arcBalance ?? null)
  arcNow.current = props.arcBalance ?? null
  const [preview, setPreview] = useState<{ amount: string; out: string; fees: number } | null>(null)
  const { arcRecipient } = props

  // Quote the Relay leg before the user signs, so "you receive" is known up front.
  useEffect(() => {
    if (!AMOUNT_RE.test(amount) || Number(amount) < MIN_WITHDRAW_PUSD) return
    let cancelled = false
    const timer = setTimeout(() => {
      getRelayRouteToArc({ arcRecipient, amount: parseUnits(amount, PUSD_DECIMALS) })
        .then((r) => !cancelled && setPreview({ amount, out: r.expectedOut, fees: r.feesUsd }))
        .catch(() => !cancelled && setPreview(null))
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [amount, arcRecipient])

  // Track the latest withdrawal, including one started before a page reload.
  useEffect(() => {
    if (!pending) return
    const controller = new AbortController()
    trackWithdrawal({
      pending,
      signal: controller.signal,
      onProgress: (p) => {
        setProgress(p)
        if (p.stage === 'arrived') {
          recordActivity(pending.arcRecipient, {
            id: `wd-${pending.startedAt}`,
            kind: 'WITHDRAW',
            title: 'Withdrawal to Arc',
            detail: 'Polymarket bridge → Relay → Arc',
            usd: Number(p.amountOut ?? pending.amount),
            timestamp: Math.floor(pending.startedAt / 1000),
            href: p.arcTxHash ? explorer.arcTx(p.arcTxHash) : undefined,
            hrefLabel: 'Arc',
          })
          toast(
            {
              kind: 'success',
              title: 'Withdrawal arrived on Arc',
              detail: p.detail,
              href: p.arcTxHash ? explorer.arcTx(p.arcTxHash) : undefined,
              linkLabel: 'View on Arc',
            },
            toastId.current,
          )
        }
        if (p.stage === 'failed') toast({ kind: 'error', title: 'Withdrawal needs attention', detail: p.detail }, toastId.current)
        if (p.stage === 'arrived') track('withdraw_done')
        if (p.stage === 'arrived' || p.stage === 'failed') {
          savePendingWithdrawal(null)
          // Show the expected Arc balance only if nothing else moved it since the withdrawal started.
          const was = pending.arcBefore
          const now = arcNow.current
          const unchanged = was != null && now != null && Math.abs(Number(now) - Number(was)) < 0.005
          onDone.current(
            p.stage === 'arrived' && unchanged ? { arc: { delta: Number(p.amountOut ?? pending.amount), before: was } } : undefined,
          )
        }
      },
    })
    return () => controller.abort()
  }, [pending])

  async function submit() {
    setSteps([])
    const log = (s: string) => setSteps((prev) => [...prev, s])
    if (!AMOUNT_RE.test(amount)) return log('Enter an amount with up to 6 decimals.')
    if (Number(amount) < MIN_WITHDRAW_PUSD) return log(`Minimum withdrawal is ${MIN_WITHDRAW_PUSD} pUSD.`)
    if (props.pusdBalance !== null && Number(amount) > Number(props.pusdBalance)) {
      return log(`You only have ${props.pusdBalance} pUSD.`)
    }
    setSending(true)
    setProgress({ stage: 'sending', detail: 'Sign the gasless pUSD transfer in your wallet…' })
    const startedAt = Date.now()
    const pusdBefore = props.pusdBalance
    try {
      await props.onPolygon()
      const res = await withdrawToArc({
        client: props.client,
        polymarketWallet: props.wallet,
        arcRecipient: props.arcRecipient,
        amount,
        onStep: log,
      })
      log(`pUSD sent: ${res.transactionHash}`)
      toastId.current = toast({
        kind: 'info',
        title: 'Withdrawal in progress',
        detail: `${amount} pUSD sent; Polymarket's bridge and Relay are delivering it to Arc.`,
        href: explorer.polygonTx(res.transactionHash),
        linkLabel: 'View on Polygon',
      })
      log(`Quoted on Arc: ~${res.route.expectedOut} USDC (Relay fees ≈ $${res.route.feesUsd.toFixed(3)}).`)
      const next = { withdrawAddress: res.withdrawAddress, arcRecipient: props.arcRecipient, startedAt, amount, arcBefore: props.arcBalance ?? null }
      savePendingWithdrawal(next)
      setPending(next)
      setAmount('')
      onDone.current({ pusd: { delta: -Number(amount), before: pusdBefore } })
    } catch (e) {
      setProgress(null)
      log(friendlyError(e))
    } finally {
      setSending(false)
    }
  }

  const order = ['sending', 'converting', 'bridging', 'arrived'] as const
  const at = progress ? order.indexOf(progress.stage as (typeof order)[number]) : -1
  const stepState = (i: number): Step['state'] => {
    if (!progress) return 'todo'
    if (progress.stage === 'failed') return i === 0 ? 'done' : i === 1 ? 'failed' : 'todo'
    if (progress.stage === 'arrived' || i < at) return 'done'
    return i === at ? 'active' : 'todo'
  }

  return (
    <div className="wl-flow">
      <div className="wl-flow-head">
        <h2>Withdraw to Arc</h2>
        <p className="sub">Send pUSD back to your Arc wallet as USDC. One gasless signature; no POL needed.</p>
      </div>
      <div className="wl-amount">
        <div className="wl-amount-top">
          <label className="eyebrow" htmlFor="wl-withdraw-amount">
            You send
          </label>
          <span className="wl-avail">
            Trading balance{' '}
            <b className="num">{props.pusdBalance !== null ? `${Number(props.pusdBalance).toFixed(2)} pUSD` : '…'}</b>
          </span>
        </div>
        <div className="wl-amount-row">
          <input
            id="wl-withdraw-amount"
            className="wl-amount-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
            inputMode="decimal"
            placeholder="0.00"
            aria-label="Withdraw amount in pUSD"
          />
          <span className="wl-unit">pUSD</span>
          {props.pusdBalance && (
            <button className="wl-max" onClick={() => setAmount(props.pusdBalance ?? '')}>
              Max
            </button>
          )}
        </div>
      </div>
      <div className="wl-summary">
        <div className="wl-sum-row">
          <span className="k">Minimum</span>
          <span className="num">{MIN_WITHDRAW_PUSD} pUSD</span>
        </div>
        <div className="wl-sum-row wl-sum-total">
          <span className="k">You receive on Arc</span>
          <span className="num">
            {preview && preview.amount === amount
              ? `≈ ${Number(preview.out).toFixed(4)} USDC (fees ≈ $${preview.fees.toFixed(3)})`
              : 'Enter an amount to get a quote'}
          </span>
        </div>
        <div className="wl-sum-row">
          <span className="k">Arrives at</span>
          <span className="mono">
            {props.arcRecipient.slice(0, 6)}…{props.arcRecipient.slice(-4)} on Arc
          </span>
        </div>
      </div>
      <div className="wl-actions">
        <button className="block wl-go" disabled={sending || !(Number(amount) >= MIN_WITHDRAW_PUSD)} onClick={submit}>
          {sending ? 'Sending…' : 'Withdraw'}
        </button>
      </div>

      {progress && (
        <Stepper
          steps={[
            { label: 'Send pUSD (gasless signature)', state: stepState(0) },
            { label: 'Polymarket converts pUSD to USDC on Polygon', state: stepState(1) },
            {
              label: 'Relay delivers USDC to Arc',
              state: stepState(2),
              href: progress.arcTxHash ? explorer.arcTx(progress.arcTxHash) : undefined,
              hrefLabel: 'View on Arc',
            },
          ]}
        />
      )}
      {progress && (
        <p className={`wl-status ${progress.stage === 'failed' ? 'error' : progress.stage === 'arrived' ? 'success' : 'muted'}`}>
          {progress.detail}{' '}
          {progress.arcTxHash && (
            <a href={explorer.arcTx(progress.arcTxHash)} target="_blank" rel="noreferrer">
              View on Arc
            </a>
          )}
        </p>
      )}
      {steps.length > 0 && (
        <ul className="wl-log muted">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      <p className="wl-fineprint">
        If Relay cannot deliver, it refunds USDC to this same address on Polygon.
      </p>
    </div>
  )
}
