import { useEffect, useRef, useState } from 'react'
import type { EIP1193Provider } from 'viem'
import { AMOUNT_RE, MIN_DEPOSIT_USDC, STORAGE, explorer, shortAddress, store } from '../config'
import type { DepositEvent, DepositResult } from '../lib/deposit'
import { getBridgeStatus } from '../lib/polyBridge'
import { recordActivity } from '../lib/activity'
import { friendlyError, toast } from '../lib/toast'
import { Stepper, type Step } from './Stepper'
import { track } from '../lib/progress'
import type { BalanceDelta } from '../lib/balanceHint'

type Stage = 'signing' | 'minting' | 'crediting' | 'credited' | 'failed'
type Pending = { depositAddress: string; startedAt: number; amount: string; burnTx?: string; pusdBefore?: string | null }

// USDC is Arc's gas token: keep a little back for the approve and burn transactions.
const GAS_RESERVE_USDC = 0.05

const savePending = (p: Pending | null) => store.set(STORAGE.pendingDeposit, p)

function loadPending(depositAddress: string): Pending | null {
  const p = store.get<Pending>(STORAGE.pendingDeposit)
  if (!p || p.depositAddress !== depositAddress || Date.now() - p.startedAt > 2 * 3600_000) return null
  return p
}

export function Deposit(props: {
  getProvider: () => Promise<EIP1193Provider>
  depositAddress: `0x${string}`
  arcAddress: string
  arcBalance: string | null
  /** Trading balance now, remembered with the deposit so the credit can be shown before the chain read catches up. */
  pusdBalance?: string | null
  switchToArc: () => Promise<unknown>
  /** Called after the Arc burn and again once pUSD is credited, with the expected balance change. */
  onDone: (delta?: BalanceDelta) => void
}) {
  const [amount, setAmount] = useState(String(MIN_DEPOSIT_USDC))
  const [events, setEvents] = useState<DepositEvent[]>([])
  const [stage, setStage] = useState<Stage | null>(null)
  const [detail, setDetail] = useState('')
  const [failed, setFailed] = useState<DepositResult | null>(null)
  // Which step a failure happened at (0 sign, 1 mint, 2 credit), for the stepper.
  const [failedAt, setFailedAt] = useState(0)
  const [pending, setPending] = useState<Pending | null>(() => loadPending(props.depositAddress))
  const [busy, setBusy] = useState(false)
  const onDone = useRef(props.onDone)
  onDone.current = props.onDone
  const toastId = useRef<number | undefined>(undefined)
  // Latest trading balance, read when the bridge credits (the polling effect outlives renders).
  const pusdNow = useRef(props.pusdBalance ?? null)
  pusdNow.current = props.pusdBalance ?? null
  // The amount of a failed transfer, so Retry finishes that one even if the field was edited.
  const failedAmount = useRef<string | null>(null)

  // After the mint, wait for Polymarket's bridge to credit pUSD; resumes after a reload.
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    setStage((s) => (s === null || s === 'minting' ? 'crediting' : s))
    const since = pending.startedAt - 2 * 60_000
    const poll = async () => {
      const txs = await getBridgeStatus(pending.depositAddress).catch(() => [])
      if (cancelled) return
      const tx = txs.find((t) => (t.createdTimeMs ?? 0) >= since)
      if (tx?.status === 'COMPLETED') {
        setStage('credited')
        setDetail(`${pending.amount} USDC deposited and credited as pUSD.`)
        savePending(null)
        recordActivity(props.arcAddress, {
          id: `dep-${pending.startedAt}`,
          kind: 'DEPOSIT',
          title: 'Deposit from Arc',
          detail: 'Arc → Circle CCTP → Polymarket',
          usd: Number(pending.amount),
          timestamp: Math.floor(pending.startedAt / 1000),
          href: pending.burnTx ? explorer.arcTx(pending.burnTx) : undefined,
          hrefLabel: 'Arc',
        })
        toast({ kind: 'success', title: 'Deposit complete', detail: `${pending.amount} USDC is now in your trading balance.` }, toastId.current)
        track('deposit_done')
        // The bridge reports the credited amount (CCTP's fee already taken); fall back to what was sent.
        const credited = tx.fromAmountBaseUnit ? Number(tx.fromAmountBaseUnit) / 1e6 : Number(pending.amount)
        // Only show the expected balance if nothing else moved it since the deposit started; otherwise
        // (a trade meanwhile, or the chain already shows the credit) a stale base would mislead.
        const was = pending.pusdBefore
        const now = pusdNow.current
        const unchanged = was != null && now != null && Math.abs(Number(now) - Number(was)) < 0.005
        onDone.current(unchanged ? { pusd: { delta: credited, before: was } } : undefined)
        return
      }
      if (tx?.status === 'FAILED') {
        setFailedAt(2)
        setStage('failed')
        setDetail('Polymarket bridge reported a failure. Use recovery.polymarket.com with your deposit address.')
        toast({ kind: 'error', title: 'Deposit failed at the Polymarket bridge', detail: 'See Wallet → Something pending? for recovery.' }, toastId.current)
        savePending(null)
        return
      }
      setDetail(`Polymarket bridge: ${tx?.status?.toLowerCase() ?? 'waiting for the USDC to arrive'}…`)
      timer = setTimeout(poll, 4_000)
    }
    let timer = setTimeout(poll, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pending, props.arcAddress])

  function onEvent(e: DepositEvent) {
    setEvents((prev) => [...prev, e])
    if (/burn/i.test(e.step)) {
      setStage('minting')
      setDetail('Burned on Arc. Circle is minting the USDC on Polygon…')
      toastId.current = toast(
        {
          kind: 'info',
          title: 'Deposit in progress',
          detail: 'Burned on Arc; Circle is minting on Polygon.',
          href: e.txHash ? (e.explorerUrl ?? explorer.arcTx(e.txHash)) : undefined,
          linkLabel: 'View on Arc',
        },
        toastId.current,
      )
    }
  }

  async function run(
    action: (lib: typeof import('../lib/deposit'), provider: EIP1193Provider) => Promise<DepositResult>,
    opts: { retry?: boolean } = {},
  ) {
    const arcBefore = props.arcBalance
    const sent = opts.retry ? (failedAmount.current ?? amount) : amount
    setBusy(true)
    setFailed(null)
    try {
      await props.switchToArc()
      const [lib, provider] = await Promise.all([
        import('../lib/deposit'),
        props.getProvider(),
      ])
      const result = await action(lib, provider)
      if (result.state === 'success') {
        const burnTx = result.steps.find((st) => /burn/i.test(st.name) && st.txHash)?.txHash
        const next = { depositAddress: props.depositAddress, startedAt: Date.now(), amount: sent, burnTx, pusdBefore: props.pusdBalance ?? null }
        savePending(next)
        setPending(next)
        failedAmount.current = null
        // A retry resumes a transfer whose burn already left Arc, so the Arc balance is already lower.
        onDone.current(opts.retry ? undefined : { arc: { delta: -Number(sent), before: arcBefore } })
      } else {
        failedAmount.current = sent
        const failedStep = result.steps.find((s) => s.state === 'error')
        setFailedAt(1)
        setStage('failed')
        setDetail(
          `The transfer stopped at "${failedStep?.name ?? 'an unknown step'}". If the burn on Arc went through, your USDC is safe and Retry will finish the mint.`,
        )
        setFailed(result)
      }
    } catch (e) {
      setStage((s) => {
        if (s === 'signing') return null
        setFailedAt(s === 'crediting' ? 2 : 1)
        return 'failed'
      })
      setDetail(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  function submit() {
    if (!AMOUNT_RE.test(amount) || Number(amount) < MIN_DEPOSIT_USDC) {
      setDetail(`Enter at least ${MIN_DEPOSIT_USDC} USDC (up to 6 decimals).`)
      return
    }
    if (props.arcBalance !== null && Number(amount) + GAS_RESERVE_USDC > Number(props.arcBalance)) {
      setDetail(`You have ${Number(props.arcBalance).toFixed(2)} USDC on Arc; keep about ${GAS_RESERVE_USDC} for gas.`)
      return
    }
    setEvents([])
    setStage('signing')
    setDetail('Approve and sign the transfer on Arc in your wallet…')
    run((lib, provider) => lib.depositArcToPolygon({ provider, amount, recipient: props.depositAddress, onEvent }))
  }

  function retry() {
    if (!failed) return
    setStage('minting')
    setDetail('Retrying the transfer…')
    run((lib, provider) => lib.retryDeposit({ provider, result: failed, onEvent }), { retry: true })
  }

  const order: Stage[] = ['signing', 'minting', 'crediting', 'credited']
  const stepState = (i: number): Step['state'] => {
    if (stage === null) return 'todo'
    if (stage === 'failed') return i < failedAt ? 'done' : i === failedAt ? 'failed' : 'todo'
    const at = order.indexOf(stage)
    if (stage === 'credited' || i < at) return 'done'
    return i === at ? 'active' : 'todo'
  }
  const burnTx = events.find((e) => e.txHash && /burn/i.test(e.step))
  const maxAmount =
    props.arcBalance !== null ? Math.max(0, Math.floor((Number(props.arcBalance) - GAS_RESERVE_USDC) * 100) / 100) : null

  return (
    <div className="wl-flow">
      <div className="wl-flow-head">
        <h2>Deposit from Arc</h2>
        <p className="sub">Move USDC from your Arc wallet into your Polymarket balance. You sign on Arc only; no POL needed.</p>
      </div>
      <div className="wl-amount">
        <div className="wl-amount-top">
          <label className="eyebrow" htmlFor="wl-deposit-amount">
            You send
          </label>
          <span className="wl-avail">
            Available on Arc{' '}
            <b className="num">{props.arcBalance !== null ? `${Number(props.arcBalance).toFixed(2)} USDC` : '…'}</b>
          </span>
        </div>
        <div className="wl-amount-row">
          <input
            id="wl-deposit-amount"
            className="wl-amount-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
            inputMode="decimal"
            aria-label="Deposit amount in USDC"
          />
          <span className="wl-unit">USDC</span>
          {maxAmount !== null && maxAmount >= MIN_DEPOSIT_USDC && (
            <button className="wl-max" onClick={() => setAmount(String(maxAmount))}>
              Max
            </button>
          )}
        </div>
      </div>
      <div className="wl-summary">
        <div className="wl-sum-row">
          <span className="k">Minimum</span>
          <span className="num">{MIN_DEPOSIT_USDC} USDC</span>
        </div>
        <div className="wl-sum-row">
          <span className="k">Circle forwarder fee</span>
          <span className="num">≈ $0.06</span>
        </div>
        <div className="wl-sum-row">
          <span className="k">Typical time</span>
          <span>about 1 minute</span>
        </div>
        <div className="wl-sum-row">
          <span className="k">Sent to</span>
          <a className="mono" href={explorer.polygonAddress(props.depositAddress)} target="_blank" rel="noreferrer">
            your Polymarket deposit address {shortAddress(props.depositAddress)}
          </a>
        </div>
      </div>
      <div className="wl-actions">
        <button className="block wl-go" disabled={busy} onClick={submit}>
          {busy ? 'Working…' : 'Deposit'}
        </button>
        {failed && (
          <button className="ghost block" disabled={busy} onClick={retry}>
            Retry
          </button>
        )}
      </div>

      {stage && (
        <Stepper
          steps={[
            {
              label: 'Sign on Arc (approve + CCTP burn)',
              state: stepState(0),
              detail: burnTx?.txHash ? `tx ${burnTx.txHash.slice(0, 10)}…` : undefined,
              href: burnTx?.txHash ? (burnTx.explorerUrl ?? explorer.arcTx(burnTx.txHash)) : undefined,
              hrefLabel: 'View on Arc',
            },
            { label: 'Circle mints USDC on Polygon', state: stepState(1) },
            { label: 'Polymarket credits pUSD', state: stepState(2) },
          ]}
        />
      )}
      {detail && (
        <p
          className={`wl-status ${stage === 'failed' ? 'error' : stage === 'credited' ? 'success' : 'muted'}`}
          role={stage === 'failed' ? 'alert' : 'status'}
        >
          {detail}{' '}
          {burnTx?.txHash && (
            <a href={burnTx.explorerUrl ?? explorer.arcTx(burnTx.txHash)} target="_blank" rel="noreferrer">
              View on Arc
            </a>
          )}
        </p>
      )}
    </div>
  )
}
