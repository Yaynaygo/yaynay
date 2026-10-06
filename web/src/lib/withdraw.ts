import { parseUnits } from 'viem'
import { ARC_USDC, POLY_BRIDGE_API, POLYGON_USDC, PUSD, PUSD_DECIMALS, RELAY_API, STORAGE, arc, bridgeHeaders, polygon, store } from '../config'
import type { PolyClient } from './polyAccount'


export type RelayRoute = { depositAddress: `0x${string}`; expectedOut: string; feesUsd: number; requestId?: string }

/**
 * Asks Relay for an open deposit address on Polygon that bridges native USDC to
 * `arcRecipient` on Arc. Open addresses accept variable amounts and are reusable
 * for the same route. Refunds go to the user's own EOA on Polygon.
 */
export async function getRelayRouteToArc(params: { arcRecipient: string; amount: bigint }): Promise<RelayRoute> {
  const res = await fetch(`${RELAY_API}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: params.arcRecipient,
      recipient: params.arcRecipient,
      refundTo: params.arcRecipient,
      originChainId: polygon.id,
      destinationChainId: arc.id,
      originCurrency: POLYGON_USDC,
      destinationCurrency: ARC_USDC,
      amount: params.amount.toString(),
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`Relay quote failed: ${body?.message ?? res.status}`)
  const step = (body.steps ?? []).find((s: { depositAddress?: string }) => s.depositAddress)
  if (!step?.depositAddress) throw new Error('Relay returned no deposit address')
  const fees = Object.values(body.fees ?? {}) as { amountUsd?: string }[]
  const feesUsd = fees.reduce((sum, f) => sum + Number(f.amountUsd ?? 0), 0)
  return {
    depositAddress: step.depositAddress,
    expectedOut: body.details?.currencyOut?.amountFormatted ?? '?',
    feesUsd,
    requestId: step.requestId,
  }
}

/** Polymarket bridge address that unwraps pUSD and sends native Polygon USDC to `recipient`. */
export async function getPolyWithdrawAddress(polymarketWallet: string, recipient: string): Promise<`0x${string}`> {
  const res = await fetch(`${POLY_BRIDGE_API}/withdraw`, {
    method: 'POST',
    headers: bridgeHeaders(),
    body: JSON.stringify({
      address: polymarketWallet,
      toChainId: String(polygon.id),
      toTokenAddress: POLYGON_USDC,
      recipientAddr: recipient,
    }),
  })
  if (!res.ok) throw new Error(`bridge /withdraw failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { address?: { evm?: string } }
  const evm = body.address?.evm
  if (!evm || !/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new Error('bridge /withdraw returned no evm address')
  return evm as `0x${string}`
}

/**
 * Withdraws pUSD from the Polymarket wallet back to the user's Arc address with no POL:
 * pUSD --(gasless relayer transfer)--> Polymarket bridge --(native USDC, Polygon)--> Relay deposit address --> Arc USDC.
 */
export async function withdrawToArc(params: {
  client: PolyClient
  polymarketWallet: string
  arcRecipient: string
  amount: string
  onStep?: (step: string) => void
}) {
  const amount = parseUnits(params.amount, PUSD_DECIMALS)
  params.onStep?.('Getting Relay route to Arc…')
  const route = await getRelayRouteToArc({ arcRecipient: params.arcRecipient, amount })
  params.onStep?.('Creating Polymarket withdrawal address…')
  const withdrawAddress = await getPolyWithdrawAddress(params.polymarketWallet, route.depositAddress)
  params.onStep?.('Sending pUSD (gasless)…')
  const handle = await params.client.transferErc20({ amount, recipientAddress: withdrawAddress, tokenAddress: PUSD })
  const outcome = await handle.wait()
  return { route, withdrawAddress, transactionHash: outcome.transactionHash }
}

export type WithdrawStage = 'sending' | 'converting' | 'bridging' | 'arrived' | 'failed'

export type WithdrawProgress = {
  stage: WithdrawStage
  detail: string
  amountOut?: string
  arcTxHash?: string
}

type RelayRequest = {
  status?: string
  createdAt?: string
  data?: {
    metadata?: { currencyIn?: { amountFormatted?: string }; currencyOut?: { amountFormatted?: string } }
    outTxs?: { chainId?: number; hash?: string }[]
  }
}

/** A withdrawal in flight, kept in localStorage so tracking survives a reload. */
export type PendingWithdrawal = {
  withdrawAddress: string
  arcRecipient: string
  startedAt: number
  amount: string
  /** Arc USDC balance when the withdrawal started (for showing the arrival before the chain read catches up). */
  arcBefore?: string | null
}

export function savePendingWithdrawal(p: PendingWithdrawal | null) {
  store.set(STORAGE.pendingWithdrawal, p)
}

export function loadPendingWithdrawal(arcRecipient: string): PendingWithdrawal | null {
  const p = store.get<PendingWithdrawal>(STORAGE.pendingWithdrawal)
  if (!p || p.arcRecipient.toLowerCase() !== arcRecipient.toLowerCase()) return null
  // Older than a day: stop showing it.
  return Date.now() - p.startedAt < 24 * 3600_000 ? p : null
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

/**
 * Polls both legs until the USDC lands on Arc: the Polymarket bridge (pUSD → Polygon USDC)
 * and then Relay (Polygon USDC → Arc). Only transfers that started with this withdrawal count,
 * because both deposit addresses are reused across withdrawals.
 */
export async function trackWithdrawal(params: {
  pending: PendingWithdrawal
  onProgress: (p: WithdrawProgress) => void
  signal?: AbortSignal
  timeoutMs?: number
}) {
  const { pending } = params
  const deadline = Date.now() + (params.timeoutMs ?? 15 * 60_000)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // Allow for clock skew between this browser and the APIs.
  const since = pending.startedAt - 2 * 60_000
  const expected = Number(pending.amount)
  let bridgeDone = false

  while (Date.now() < deadline && !params.signal?.aborted) {
    if (!bridgeDone) {
      const body = await getJson<{ transactions?: { status?: string; createdTimeMs?: number }[] }>(
        `${POLY_BRIDGE_API}/status/${pending.withdrawAddress}`,
      )
      const tx = (body?.transactions ?? []).find((t) => (t.createdTimeMs ?? 0) >= since)
      if (tx?.status === 'COMPLETED') bridgeDone = true
      else if (tx?.status === 'FAILED') {
        params.onProgress({ stage: 'failed', detail: 'Polymarket bridge reported a failure. Check recovery.polymarket.com.' })
        return
      } else {
        params.onProgress({ stage: 'converting', detail: `Polymarket bridge: ${tx?.status?.toLowerCase() ?? 'waiting for pUSD'}…` })
      }
    }

    if (bridgeDone) {
      const body = await getJson<{ requests?: RelayRequest[] }>(`${RELAY_API}/requests/v2?user=${pending.arcRecipient}&limit=10`)
      const req = (body?.requests ?? []).find((r) => {
        if (!r.createdAt || Date.parse(r.createdAt) < since) return false
        const amountIn = Number(r.data?.metadata?.currencyIn?.amountFormatted ?? NaN)
        // The bridge pays out slightly less than the pUSD sent; anything far off is another transfer.
        return !Number.isFinite(amountIn) || Math.abs(amountIn - expected) <= Math.max(0.05, expected * 0.03)
      })
      const amountOut = req?.data?.metadata?.currencyOut?.amountFormatted
      const arcTxHash = req?.data?.outTxs?.find((t) => Number(t.chainId) === arc.id)?.hash
      if (req?.status === 'success') {
        params.onProgress({ stage: 'arrived', detail: `Arrived on Arc: +${amountOut} USDC`, amountOut, arcTxHash })
        return
      }
      if (req?.status === 'failure' || req?.status === 'refund') {
        params.onProgress({ stage: 'failed', detail: `Relay ${req.status}: funds are refunded to your address on Polygon.` })
        return
      }
      params.onProgress({ stage: 'bridging', detail: `Relay: ${req?.status ?? 'waiting for USDC'} → Arc…`, amountOut })
    }
    await sleep(3_000)
  }
  if (!params.signal?.aborted) {
    params.onProgress({ stage: 'failed', detail: 'Still in progress after 15 minutes; it may complete later.' })
  }
}
