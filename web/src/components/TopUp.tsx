import { useEffect, useMemo, useRef, useState } from 'react'
import { encodeFunctionData, erc20Abi, formatUnits, numberToHex, parseAbiItem, parseUnits, type Address, type EIP1193Provider, type Hex } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { ARC_USDC, explorer, shortAddress, store } from '../config'
import { recordActivity } from '../lib/activity'
import {
  ARC_CHAIN_ID,
  COST_WARN_SHARE,
  LifiError,
  PENDING_TOPUP_KEY,
  SOURCES,
  UnsafeQuoteError,
  afterReplacement,
  approvalNeeded,
  assertSafeQuote,
  breakdown,
  chainDiamondOk,
  checkQuote,
  defaultSlippage,
  fetchQuote,
  fetchSourceChains,
  fetchSourceTokens,
  fetchStatus,
  gasWithBuffer,
  findSource,
  interpretStatus,
  matchArrival,
  needsAllowanceReset,
  parseAmount,
  validPending,
  type LifiChain,
  type LifiQuote,
  type PendingTopUp,
  type QuoteExpectation,
  type SourceChain,
  type SourceToken,
} from '../lib/lifi'
import { friendlyError, toast } from '../lib/toast'
import { wagmiConfig } from '../wagmi'
import { Stepper, type Step } from './Stepper'
import '../styles/topup.css'

type ChainId = (typeof wagmiConfig)['chains'][number]['id']
type MetaToken = SourceToken & { logoURI?: string; priceUSD?: number }
type Stage = 'switch' | 'approve' | 'send' | 'bridge' | 'done' | 'failed'
const ORDER: Stage[] = ['switch', 'approve', 'send', 'bridge', 'done']

const savePending = (p: PendingTopUp | null) => store.set(PENDING_TOPUP_KEY, p)
const fmt = (n: number, max = 4) => n.toLocaleString(undefined, { maximumFractionDigits: max })
const money = (n: number) => (n > 0 && n < 0.001 ? '< $0.001' : `$${n.toFixed(n < 1 ? 3 : 2)}`)
const hideImg = (e: { currentTarget: HTMLImageElement }) => {
  e.currentTarget.style.visibility = 'hidden'
}
const duration = (s: number) => (s < 60 ? 'under a minute' : `about ${Math.round(s / 60)} min`)

// LI.FI limits anonymous quotes per IP per hour: cache previews briefly and back off after a 429.
const QUOTE_TTL_MS = 20_000
const QUOTE_DEBOUNCE_MS = 1_200
const quoteCache = new Map<string, { q: LifiQuote; at: number }>()
let quoteCooldownUntil = 0

const waitText = (ms: number) => {
  const min = Math.ceil(ms / 60_000)
  return min <= 1 ? 'about a minute' : min < 90 ? `about ${min} minutes` : `about ${Math.round(min / 60)} hours`
}
const rateLimited = (ms?: number) =>
  `LI.FI's free quote limit is used up for your network right now. Try again in ${waitText(ms ?? 10 * 60_000)}.`

function lifiMessage(e: unknown): string {
  if (e instanceof UnsafeQuoteError) return e.message
  if (e instanceof TxEndedError) return e.message
  if (e instanceof LifiError) {
    if (e.status === 429) {
      quoteCooldownUntil = Date.now() + (e.retryAfterMs ?? 10 * 60_000)
      return rateLimited(e.retryAfterMs)
    }
    if (/no available quotes|no routes/i.test(e.message)) return 'No route for this amount right now. Try a different amount or token.'
    return e.message
  }
  return friendlyError(e)
}

/** Switches the wallet to `chainId`, adding the network first if the wallet doesn't know it. */
async function ensureChain(provider: EIP1193Provider, chainId: number) {
  const current = Number(await provider.request({ method: 'eth_chainId' }))
  if (current === chainId) return
  const hex = numberToHex(chainId)
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (e) {
    const err = e as { code?: number; data?: { originalError?: { code?: number } } }
    const unknown = err.code === 4902 || err.data?.originalError?.code === 4902
    const chain = wagmiConfig.chains.find((c) => c.id === chainId)
    if (!unknown || !chain) throw e
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hex,
          chainName: chain.name,
          // Wallets require 18 decimals here even where the chain reports another value (Tempo).
          nativeCurrency: { name: chain.nativeCurrency.name, symbol: chain.nativeCurrency.symbol, decimals: 18 },
          rpcUrls: [...chain.rpcUrls.default.http],
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    })
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  }
  if (Number(await provider.request({ method: 'eth_chainId' })) !== chainId) {
    throw new Error('Your wallet is on a different network. Switch networks and try again.')
  }
}

/** Arc USDC transfers to the user since the top-up was sent, matched against the expected amount. */
async function findArcArrival(p: PendingTopUp) {
  const client = getPublicClient(wagmiConfig, { chainId: ARC_CHAIN_ID as ChainId }) as unknown as {
    getBlockNumber: () => Promise<bigint>
    getBlock: (a: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>
    getLogs: (a: unknown) => Promise<{ args: { value?: bigint }; blockNumber: bigint; transactionHash: Hex }[]>
  }
  const latest = await client.getBlockNumber()
  // Arc makes about two blocks a second; search back to a little before the send (at most ~4 hours).
  // Arc RPCs refuse log ranges of 10,000 blocks or more, so the search runs in chunks.
  const back = Math.min(29_997, Math.ceil(((Date.now() - p.startedAt) / 1000 + 120) * 2.2))
  const from = latest > BigInt(back) ? latest - BigInt(back) : 0n
  const event = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
  const logs: Awaited<ReturnType<typeof client.getLogs>> = []
  for (let start = from; start <= latest; start += 9_999n) {
    const end = start + 9_998n < latest ? start + 9_998n : latest
    logs.push(...(await client.getLogs({ address: ARC_USDC, event, args: { to: p.user as Address }, fromBlock: start, toBlock: end })))
  }
  if (logs.length === 0) return null
  const transfers = await Promise.all(
    logs.slice(-10).map(async (l) => ({
      value: l.args.value ?? 0n,
      timestamp: Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp),
      txHash: l.transactionHash,
    })),
  )
  return matchArrival(transfers, { expected: Number(p.expected), sinceSec: Math.floor(p.startedAt / 1000) })
}

/** Sends a raw transaction through the wallet after confirming it is on the expected chain. */
async function sendTx(provider: EIP1193Provider, chainId: number, tx: { from: Address; to: Address; data: Hex; value?: bigint; gas?: string }) {
  if (Number(await provider.request({ method: 'eth_chainId' })) !== chainId) {
    throw new Error('Your wallet is on a different network. Switch networks and try again.')
  }
  return provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        chainId: numberToHex(chainId),
        value: numberToHex(tx.value ?? 0n),
        ...(tx.gas ? { gas: tx.gas as Hex } : {}),
      },
    ],
  })
}

/** The transaction is final and did not go through (reverted, or cancelled from the wallet). */
class TxEndedError extends Error {
  reason: 'reverted' | 'cancelled'
  constructor(reason: 'reverted' | 'cancelled', message: string) {
    super(message)
    this.name = 'TxEndedError'
    this.reason = reason
  }
}

/**
 * Waits for the receipt, following a wallet "speed up" to its replacement hash. A wallet "cancel"
 * or a revert throws TxEndedError; timeouts and RPC errors are thrown as-is (outcome unknown).
 */
async function waitFor(chainId: number, hash: Hex, onReplaced?: (hash: Hex) => void) {
  const client = getPublicClient(wagmiConfig, { chainId: chainId as ChainId })
  let cancelled = false
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: 10 * 60_000,
    onReplaced: (r) => {
      if (r.reason === 'cancelled') cancelled = true
      else onReplaced?.(r.transaction.hash)
    },
  })
  if (cancelled) throw new TxEndedError('cancelled', 'The transaction was cancelled in your wallet, so nothing was sent.')
  if (receipt.status !== 'success') throw new TxEndedError('reverted', 'The transaction reverted on-chain. Nothing was sent.')
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) onReplaced?.(receipt.transactionHash)
  return receipt
}

/** "Top up Arc from any chain": bring curated tokens from other chains (or swap on Arc) into the user's own Arc USDC via LI.FI. */
export function TopUp(props: {
  address?: string
  isConnected: boolean
  canSign: boolean
  getProvider: () => Promise<EIP1193Provider>
  onConnect: () => void
  onDone: () => void
}) {
  const user = props.address as Address | undefined
  const [pending, setPending] = useState<PendingTopUp | null>(() => validPending(store.get(PENDING_TOPUP_KEY), user))
  const [open, setOpen] = useState(() => !!pending)
  const [chainId, setChainId] = useState(SOURCES[0].id)
  const source = findSource(chainId) as SourceChain
  const [tokenAddr, setTokenAddr] = useState<string>(source.tokens[0].address)
  const [chains, setChains] = useState<Map<number, LifiChain>>(new Map())
  const [tokens, setTokens] = useState<Record<number, MetaToken[]>>({})
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<{ key: string; q?: LifiQuote; error?: string } | null>(null)
  const [stage, setStage] = useState<Stage | null>(() => (pending ? 'bridge' : null))
  const [failedAt, setFailedAt] = useState<Stage>('switch')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)
  const [txs, setTxs] = useState<{ approve?: string; send?: string; arc?: string }>(() => (pending ? { send: pending.txHash } : {}))
  const [approvalSkipped, setApprovalSkipped] = useState(false)
  const onDone = useRef(props.onDone)
  useEffect(() => {
    onDone.current = props.onDone
  })
  const toastId = useRef<number | undefined>(undefined)

  // LI.FI metadata only when the card is opened.
  useEffect(() => {
    if (!open || chains.size) return
    const c = new AbortController()
    fetchSourceChains(c.signal).then(setChains, () => {})
    return () => c.abort()
  }, [open, chains.size])

  useEffect(() => {
    if (!open || tokens[chainId]) return
    const c = new AbortController()
    fetchSourceTokens(source, c.signal).then(
      (list) => setTokens((t) => ({ ...t, [chainId]: list })),
      () => {},
    )
    return () => c.abort()
  }, [open, chainId, source, tokens])

  const list: MetaToken[] = tokens[chainId] ?? source.tokens
  const token: MetaToken = list.find((t) => t.address === tokenAddr) ?? list[0]
  const slippage = defaultSlippage(token)
  const diamondOk = chainDiamondOk(source, chains.get(chainId))

  // Balance on the source chain, for Max and the "not enough" check.
  const nativeBal = useBalance({
    address: user,
    chainId: chainId as ChainId,
    query: { enabled: open && !!user && !!token.native },
  })
  const tokenBal = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: user ? [user] : undefined,
    chainId: chainId as ChainId,
    query: { enabled: open && !!user && !token.native },
  })
  const balance: bigint | undefined = token.native ? nativeBal.data?.value : tokenBal.data
  const maxRaw =
    balance === undefined ? undefined : token.native ? balance - parseUnits(source.gasReserve, token.decimals) : balance

  const raw = parseAmount(amount, token.decimals)
  const short = raw !== null && balance !== undefined && raw > balance
  const quoteKey = `${chainId}:${token.address}:${raw ?? ''}:${user ?? ''}`
  const request = useMemo<QuoteExpectation | null>(
    () => (raw && user ? { source, token, amount: raw, user, slippage, refPriceUSD: token.priceUSD } : null),
    [raw, user, source, token, slippage],
  )

  const requestRef = useRef(request)
  useEffect(() => {
    requestRef.current = request
  })

  // Live quote preview: debounced, re-fetched only when (chain, token, amount) changes, cached briefly.
  useEffect(() => {
    if (!open || !raw || !user || stage) return
    const c = new AbortController()
    const cached = quoteCache.get(quoteKey)
    const fresh = cached && Date.now() - cached.at < QUOTE_TTL_MS
    const timer = setTimeout(() => {
      const req = requestRef.current
      if (!req) return
      if (fresh) return setQuote({ key: quoteKey, q: cached.q })
      if (Date.now() < quoteCooldownUntil) return setQuote({ key: quoteKey, error: rateLimited(quoteCooldownUntil - Date.now()) })
      fetchQuote(req, c.signal).then(
        (q) => {
          quoteCache.set(quoteKey, { q, at: Date.now() })
          setQuote({ key: quoteKey, q })
        },
        (e) => !c.signal.aborted && setQuote({ key: quoteKey, error: lifiMessage(e) }),
      )
    }, fresh ? 0 : QUOTE_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      c.abort()
    }
  }, [open, raw, user, quoteKey, stage])

  // Follow the transfer on LI.FI until USDC lands on Arc; resumes after a reload.
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const s = await fetchStatus({ txHash: pending.txHash, fromChainId: pending.fromChainId, tool: pending.tool }).catch(() => null)
      if (cancelled) return
      let r = interpretStatus(s, pending.txHash)
      // LI.FI can't track some routes (Tempo): when it doesn't know the transfer at all, look for the
      // USDC on Arc ourselves after a minute. Routes LI.FI does track wait for its answer, so an
      // unrelated transfer of a similar size (say a Polymarket withdrawal) is never taken for this one.
      const untracked = !s || s.status === 'NOT_FOUND'
      if (r.phase === 'pending' && untracked && Date.now() - pending.startedAt > 60_000) {
        const arrival = await findArcArrival(pending).catch(() => null)
        if (cancelled) return
        if (arrival) r = { phase: 'done', received: arrival.amount, arcTx: arrival.txHash }
      }
      if (r.phase === 'pending') {
        // LI.FI doesn't know the hash yet: after a reload, check the source chain for a revert.
        if (!s || s.status === 'NOT_FOUND') {
          const receipt = await getPublicClient(wagmiConfig, { chainId: pending.fromChainId as ChainId })
            .getTransactionReceipt({ hash: pending.txHash as Hex })
            .catch(() => null)
          if (cancelled) return
          if (receipt?.status === 'reverted') {
            savePending(null)
            setPending(null)
            setFailedAt('send')
            setStage('failed')
            setDetail('The transaction reverted on-chain. Nothing was sent.')
            return
          }
        }
        const stale = (!s || s.status === 'NOT_FOUND') && Date.now() - pending.startedAt > 30 * 60_000
        setStage((st) => (st === 'send' || st === null ? 'bridge' : st))
        setDetail(
          stale
            ? "LI.FI still can't find this transaction. If you sped it up or cancelled it in your wallet, check your wallet's activity; you can stop tracking here."
            : (r.message ?? `${pending.toolName} is moving your funds to Arc. Slower bridges take up to ~20 minutes.`),
        )
        timer = setTimeout(poll, 10_000)
        return
      }
      savePending(null)
      setPending(null)
      const from = findSource(pending.fromChainId)?.name ?? 'another chain'
      if (r.phase === 'done' || r.phase === 'partial') {
        setStage('done')
        setTxs((t) => ({ ...t, arc: r.arcTx }))
        const got = r.received !== undefined ? `${fmt(r.received)} USDC` : 'Your USDC'
        setDetail(
          r.phase === 'partial'
            ? (r.message ?? 'The route delivered a different token on Arc. Check your Arc wallet.')
            : `${got} arrived at your Arc address.`,
        )
        recordActivity(pending.user, {
          id: `topup-${pending.startedAt}`,
          kind: 'OTHER',
          title: pending.fromChainId === ARC_CHAIN_ID ? `Swap ${pending.symbol} to USDC on Arc` : `Top up from ${from}`,
          detail: `${pending.amount} ${pending.symbol} → ${r.received !== undefined ? fmt(r.received) : pending.expected} USDC on Arc via ${pending.toolName}`,
          usd: r.received ?? Number(pending.expected),
          timestamp: Math.floor(pending.startedAt / 1000),
          href: r.arcTx ? explorer.arcTx(r.arcTx) : undefined,
          hrefLabel: 'Arc',
        })
        toast(
          {
            kind: 'success',
            title: 'Top-up arrived on Arc',
            detail: r.phase === 'partial' ? 'Delivered as a different token; check your Arc wallet.' : `${got} is in your Arc wallet.`,
            href: r.arcTx ? explorer.arcTx(r.arcTx) : undefined,
            linkLabel: 'View on Arc',
          },
          toastId.current,
        )
        onDone.current()
        return
      }
      setFailedAt('bridge')
      setStage('failed')
      setDetail(
        r.phase === 'refunded'
          ? `The bridge refunded your ${pending.symbol} on ${from}. ${r.message ?? ''}`.trim()
          : `The transfer failed on ${pending.toolName}. ${r.message ?? 'Check it on scan.li.fi with your transaction hash.'}`,
      )
      toast({ kind: 'error', title: r.phase === 'refunded' ? 'Top-up refunded' : 'Top-up failed', detail: `Source transaction ${pending.txHash.slice(0, 10)}…` }, toastId.current)
    }
    timer = setTimeout(poll, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pending])

  function pickChain(id: number) {
    const s = findSource(id)
    if (!s || busy) return
    setChainId(id)
    setTokenAddr(s.tokens[0].address)
    setAmount('')
    setQuote(null)
  }

  async function run() {
    if (!user || !raw || !request) return
    setBusy(true)
    setStage('switch')
    setDetail(`Switch your wallet to ${source.name}…`)
    setTxs({})
    setApprovalSkipped(false)
    let at: Stage = 'switch'
    try {
      const provider = await props.getProvider()
      await ensureChain(provider, source.id)

      // Always sign against a fresh quote that passed every check.
      setDetail('Getting a fresh quote and checking it…')
      let q = await fetchQuote(request)
      assertSafeQuote(q, request)

      at = 'approve'
      setStage('approve')
      if (!token.native) {
        const client = getPublicClient(wagmiConfig, { chainId: source.id as ChainId })
        const allowance = await client.readContract({ address: token.address, abi: erc20Abi, functionName: 'allowance', args: [user, source.diamond] })
        const need = approvalNeeded(token, allowance, raw)
        if (need !== null) {
          if (needsAllowanceReset(source.id, token, allowance)) {
            setDetail(`${token.symbol} needs its old allowance cleared first. Confirm in your wallet…`)
            const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [source.diamond, 0n] })
            await waitFor(source.id, await sendTx(provider, source.id, { from: user, to: token.address, data }))
          }
          setDetail(`Approve exactly ${amount} ${token.symbol} for LI.FI's contract in your wallet…`)
          const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [source.diamond, need] })
          const hash = await sendTx(provider, source.id, { from: user, to: token.address, data })
          setTxs((t) => ({ ...t, approve: hash }))
          await waitFor(source.id, hash, (h) => setTxs((t) => ({ ...t, approve: h })))
          // The approval took a while; re-quote so the route and minimum are current.
          q = await fetchQuote(request)
          assertSafeQuote(q, request)
        } else setApprovalSkipped(true)
      } else setApprovalSkipped(true)

      at = 'send'
      setStage('send')
      setDetail(`Confirm the ${source.sameChain ? 'swap' : 'transfer'} on ${source.name} in your wallet…`)
      const tx = q.transactionRequest!
      const call = { account: user, to: tx.to as Address, data: tx.data as Hex, value: BigInt(tx.value ?? '0') }
      // Simulate first: a route that would revert is stopped here instead of costing a failed transaction,
      // and the estimate replaces LI.FI's gas figure, which is too low on some chains (Tempo).
      let estimate: bigint | null = null
      try {
        // Typed loosely: the per-chain client union is too large for TypeScript to resolve here.
        const client = getPublicClient(wagmiConfig, { chainId: source.id as ChainId }) as unknown as {
          estimateGas: (args: typeof call) => Promise<bigint>
        }
        estimate = await client.estimateGas(call)
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e)
        if (/revert/i.test(text)) {
          throw new Error(`This route would fail on ${source.name} right now (the simulation reverted), so nothing was sent. Get a new quote and try again.`)
        }
        // RPC trouble: fall back to LI.FI's figure with a margin.
      }
      const hash = await sendTx(provider, source.id, {
        from: user,
        to: call.to,
        data: call.data,
        value: call.value,
        gas: (() => {
          const g = gasWithBuffer(estimate, tx.gasLimit)
          return g === undefined ? undefined : numberToHex(g)
        })(),
      })
      setTxs((t) => ({ ...t, send: hash }))
      const b = breakdown(q, token, token.priceUSD)
      let current: PendingTopUp = {
        user,
        txHash: hash,
        fromChainId: source.id,
        tool: q.tool,
        toolName: b.toolName,
        symbol: token.symbol,
        amount,
        expected: b.toAmount.toFixed(6),
        startedAt: Date.now(),
      }
      // From here on the transfer is tracked (and survives a reload) whatever happens below,
      // so a failed receipt wait can never lead to sending twice.
      savePending(current)
      setPending(current)
      at = 'bridge'
      setStage('bridge')
      toastId.current = toast({
        kind: 'info',
        title: source.sameChain ? 'Swap sent on Arc' : `Top-up sent on ${source.name}`,
        detail: source.sameChain ? 'Waiting for the swap to settle.' : `${b.toolName} is moving it to Arc (${duration(b.seconds)}).`,
      })
      onDone.current()
      try {
        await waitFor(source.id, hash, (h) => {
          // Sped up in the wallet: LI.FI only knows the replacement hash.
          const next = afterReplacement(current, 'replaced', h)
          if (!next) return
          current = next
          savePending(next)
          setPending(next)
          setTxs((t) => ({ ...t, send: h }))
        })
      } catch (e) {
        if (!(e instanceof TxEndedError)) {
          // Timeout or RPC trouble: the outcome is unknown, so keep following it on LI.FI.
          setDetail(`Couldn't confirm the ${source.name} transaction yet; still tracking it.`)
          return
        }
        savePending(null)
        setPending(null)
        setFailedAt('send')
        setStage('failed')
        setDetail(e.message)
        toast({ kind: 'error', title: e.reason === 'cancelled' ? 'Top-up cancelled' : 'Top-up reverted', detail: e.message }, toastId.current)
      }
    } catch (e) {
      const msg = lifiMessage(e)
      // Cancelling before the transfer was sent (wallet prompt or a cancelled approval) just resets the flow.
      const userCancel = /cancelled the request/.test(msg) || (e instanceof TxEndedError && e.reason === 'cancelled')
      if (userCancel && at !== 'send') {
        setStage(null)
        setDetail(msg)
      } else {
        setFailedAt(at)
        setStage('failed')
        setDetail(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  // The funds still move on-chain; this only forgets the saved transfer (e.g. one cancelled in the wallet).
  function stopTracking() {
    savePending(null)
    setPending(null)
    reset()
  }

  function reset() {
    setStage(null)
    setDetail('')
    setTxs({})
    setQuote(null)
  }

  const q = quote?.key === quoteKey ? quote.q : undefined
  const problems = q && request ? checkQuote(q, request) : []
  const b = q ? breakdown(q, token, token.priceUSD) : null
  const swapping = !(token.kind === 'stable' && /^USDC/.test(token.symbol))
  const canGo = !!q && !problems.length && !short && !busy && !stage && diamondOk && props.canSign

  const flowSource = pending ? (findSource(pending.fromChainId) ?? source) : source
  const sameChain = !!flowSource.sameChain
  const symbol = pending?.symbol ?? token.symbol
  const plan: { key: Stage; label: string }[] = [
    { key: 'switch', label: `Switch wallet to ${flowSource.name}` },
    { key: 'approve', label: approvalSkipped ? 'No approval needed' : `Approve exactly this amount of ${symbol}` },
    { key: 'send', label: sameChain ? 'Swap on Arc' : `Send on ${flowSource.name}` },
    ...(sameChain ? [] : [{ key: 'bridge' as const, label: `Bridge to Arc via ${pending?.toolName ?? b?.toolName ?? 'LI.FI'}` }]),
    { key: 'done', label: 'USDC in your Arc wallet' },
  ]
  const steps: (Step & { key: Stage })[] = plan.map((s) => ({ ...s, state: stepState(s.key) }))

  function stepState(key: Stage): Step['state'] {
    const i = ORDER.indexOf(key)
    if (stage === null) return 'todo'
    if (stage === 'failed') {
      const f = ORDER.indexOf(failedAt)
      return i < f ? 'done' : i === f ? 'failed' : 'todo'
    }
    const at = ORDER.indexOf(stage)
    if (stage === 'done' || i < at) return 'done'
    return i === at ? 'active' : 'todo'
  }

  const txLink = (hash?: string) => (hash ? `${flowSource.explorer}/tx/${hash}` : undefined)
  for (const s of steps) {
    if (s.key === 'approve' && txs.approve) Object.assign(s, { href: txLink(txs.approve), hrefLabel: 'Approval' })
    if (s.key === 'send' && txs.send) Object.assign(s, { href: txLink(txs.send), hrefLabel: `View on ${flowSource.name}` })
    if (s.key === 'bridge' && txs.send) Object.assign(s, { href: `https://scan.li.fi/tx/${txs.send}`, hrefLabel: 'Track on LI.FI' })
    if (s.key === 'done' && txs.arc) Object.assign(s, { href: explorer.arcTx(txs.arc), hrefLabel: 'View on Arc' })
  }

  return (
    <details className="card tu-card" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="tu-summary">
        <span className="tu-summary-ico" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h11l-3-3M20 17H9l3 3" />
          </svg>
        </span>
        <span className="tu-summary-text">
          <b>Top up Arc from another chain</b>
          <small>
            {pending
              ? `Top-up in progress from ${findSource(pending.fromChainId)?.name ?? 'another chain'}…`
              : 'Have USDC, USDT, ETH or BTC elsewhere? Turn it into USDC on Arc, then deposit.'}
          </small>
        </span>
        <span className="tu-badge">LI.FI</span>
      </summary>

      <div className="tu-body">
        {!props.isConnected ? (
          <div className="tu-empty">
            <p>Connect your wallet to bring funds from Base, Arbitrum, Optimism, Polygon, Ethereum, BNB Chain or Tempo to your Arc address.</p>
            <button onClick={props.onConnect}>Connect wallet</button>
          </div>
        ) : (
          <>
            {stage ? (
              <p className="tu-flow-line">
                {pending
                  ? `${pending.amount} ${pending.symbol} from ${flowSource.name} → USDC on Arc`
                  : `${amount} ${token.symbol} from ${source.name} → USDC on Arc`}
              </p>
            ) : (
              <>
              <fieldset className="tu-chains" disabled={busy || !!stage}>
                <legend className="eyebrow">From</legend>
                {SOURCES.map((s) => {
                  const meta = chains.get(s.id)
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`tu-chip ${s.id === chainId ? 'on' : ''}`}
                      aria-pressed={s.id === chainId}
                      onClick={() => pickChain(s.id)}
                    >
                      {meta?.logoURI ? <img src={meta.logoURI} alt="" width={20} height={20} onError={hideImg} /> : <span className="tu-dot" aria-hidden="true" />}
                      {s.sameChain ? 'Arc · swap' : s.name}
                    </button>
                  )
                })}
              </fieldset>

              <fieldset className="tu-tokens" disabled={busy || !!stage}>
                <legend className="eyebrow">Token</legend>
                {list.map((t) => (
                  <button
                    key={t.address}
                    type="button"
                    className={`tu-chip small ${t.address === token.address ? 'on' : ''}`}
                    aria-pressed={t.address === token.address}
                    onClick={() => {
                      setTokenAddr(t.address)
                      setAmount('')
                    }}
                  >
                    {t.logoURI ? <img src={t.logoURI} alt="" width={18} height={18} onError={hideImg} /> : <span className="tu-dot" aria-hidden="true" />}
                    {t.symbol}
                  </button>
                ))}
              </fieldset>
              {token.label && <p className="tu-note">{token.label}</p>}

              <div className="wl-amount">
                <div className="wl-amount-top">
                  <label className="eyebrow" htmlFor="tu-amount">
                    You send
                  </label>
                  <span className="wl-avail">
                    On {source.name}{' '}
                    <b className="num">
                      {balance !== undefined ? `${fmt(Number(formatUnits(balance, token.decimals)), 6)} ${token.symbol}` : '…'}
                    </b>
                  </span>
                </div>
                <div className="wl-amount-row">
                  <input
                    id="tu-amount"
                    className="wl-amount-input"
                    value={amount}
                    placeholder="0"
                    disabled={busy || !!stage}
                    onChange={(e) => setAmount(e.target.value.trim())}
                    inputMode="decimal"
                    aria-label={`Amount in ${token.symbol}`}
                  />
                  <span className="wl-unit">{token.symbol}</span>
                  {maxRaw !== undefined && maxRaw > 0n && !stage && (
                    <button type="button" className="wl-max" onClick={() => setAmount(formatUnits(maxRaw, token.decimals))}>
                      Max
                    </button>
                  )}
                </div>
              </div>
              {short && <p className="tu-warn" role="alert">You have less {token.symbol} on {source.name} than that.</p>}
              {!diamondOk && <p className="tu-warn" role="alert">LI.FI's contract on {source.name} doesn't match the one we expect, so this source is paused.</p>}
              </>
            )}

            {raw && !stage && (
              <div className="wl-summary tu-quote" aria-live="polite">
                {quote?.key !== quoteKey && <div className="wl-sum-row muted">Finding the best route…</div>}
                {quote?.key === quoteKey && quote.error && <div className="wl-sum-row tu-err">{quote.error}</div>}
                {q && b && (
                  <>
                    {swapping && (
                      <div className="wl-sum-row">
                        <span className="k">You're selling</span>
                        <span>
                          {amount} {token.symbol} for USDC <span className="muted num">(≈ {money(b.inUsd)})</span>
                        </span>
                      </div>
                    )}
                    <div className="wl-sum-row wl-sum-total">
                      <span className="k">You receive on Arc</span>
                      <span className="num">≈ {fmt(b.toAmount)} USDC</span>
                    </div>
                    <div className="wl-sum-row">
                      <span className="k">Minimum received</span>
                      <span className="num">
                        {fmt(b.toAmountMin)} USDC <span className="muted">· {slippage * 100}% max slippage</span>
                      </span>
                    </div>
                    <div className="wl-sum-row">
                      <span className="k">Route</span>
                      <span>{b.route.length > 1 ? b.route.join(' → ') : b.toolName}</span>
                    </div>
                    {b.fees.map((f, i) => (
                      <div className="wl-sum-row" key={`${f.name}-${i}`}>
                        <span className="k">{f.name}</span>
                        <span className="num">{money(f.usd)}</span>
                      </div>
                    ))}
                    <div className="wl-sum-row">
                      <span className="k">Network gas{b.gas.symbol ? ` (${b.gas.symbol} on ${source.name})` : ''}</span>
                      <span className="num">{money(b.gas.usd)}</span>
                    </div>
                    <div className="wl-sum-row">
                      <span className="k">Our fee</span>
                      <span className="num">0%</span>
                    </div>
                    <div className="wl-sum-row">
                      <span className="k">Total fees and gas</span>
                      <span className="num">
                        {money(b.costUsd)} <span className="muted">({(b.costShare * 100).toFixed(2)}%)</span>
                      </span>
                    </div>
                    <div className="wl-sum-row">
                      <span className="k">Estimated time</span>
                      <span>{duration(b.seconds)}</span>
                    </div>
                    <div className="wl-sum-row">
                      <span className="k">Arrives at</span>
                      <a className="mono" href={user ? explorer.arcAddress(user) : undefined} target="_blank" rel="noreferrer">
                        your Arc address {shortAddress(user)}
                      </a>
                    </div>
                  </>
                )}
              </div>
            )}

            {q && b && !stage && (
              <div className="tu-notes">
                {problems.length > 0 && (
                  <p className="tu-warn" role="alert">
                    We won't sign this quote: {problems.join(' ')}
                    {b.costShare > 0.2 && ' Try a larger amount.'}
                  </p>
                )}
                {!problems.length && b.costShare > COST_WARN_SHARE && (
                  <p className="tu-warn">
                    Fees and gas are {(b.costShare * 100).toFixed(1)}% of this amount. A larger amount spreads the fixed costs.
                  </p>
                )}
                {token.kind !== 'stable' && (
                  <p className="tu-note">
                    {source.sameChain
                      ? 'The price can move before the swap settles. If the output would fall below the minimum received, the swap reverts instead.'
                      : 'The price can move while a slower bridge runs. If the output would fall below the minimum received, the route reverts or refunds instead of delivering less.'}
                  </p>
                )}
                {swapping && <p className="tu-note">Swapping can be a taxable event in some countries.</p>}
              </div>
            )}

            <div className="wl-actions">
              {!props.canSign ? (
                <button className="ghost block" onClick={props.onConnect}>
                  Reconnect wallet
                </button>
              ) : stage === 'done' || stage === 'failed' ? (
                <button className="ghost block" onClick={reset}>
                  {stage === 'done' ? 'Top up again' : 'Start over'}
                </button>
              ) : (
                <button className="block tu-go" disabled={!canGo} onClick={run}>
                  {busy ? 'Working…' : stage === 'bridge' ? 'Bridging to Arc…' : source.sameChain ? 'Swap to USDC on Arc' : `Top up Arc from ${source.name}`}
                </button>
              )}
              {pending && stage === 'bridge' && (
                <button type="button" className="link tu-stop" onClick={stopTracking}>
                  Stop tracking this top-up
                </button>
              )}
            </div>

            {stage && <Stepper steps={steps} />}
            {detail && (
              <p
                className={`wl-status ${stage === 'failed' ? 'error' : stage === 'done' ? 'success' : 'muted'}`}
                role={stage === 'failed' ? 'alert' : 'status'}
              >
                {detail}
              </p>
            )}

            <p className="wl-fineprint">
              Routes come from LI.FI and third-party bridges (Across, Relay, Polymer and others). Funds always arrive as USDC at
              your own Arc address; you sign every step and we never hold them. Fast routes take seconds, slower bridges up to
              ~20 minutes. Approvals are for the exact amount, never unlimited.
            </p>
          </>
        )}
      </div>
    </details>
  )
}
