// Loaded on demand (dynamic import) because App Kit and its Solana dependencies are ~1.3 MB.
import { Buffer } from 'buffer'
import type { EIP1193Provider } from 'viem'

// App Kit bundles Solana libraries that reference the Node `Buffer` global.
const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer }
g.Buffer ??= Buffer

const { AppKit } = await import('@circle-fin/app-kit')
const { createViemAdapterFromProvider } = await import('@circle-fin/adapter-viem-v2')

const kit = new AppKit()

export type DepositEvent = { step: string; txHash?: string; explorerUrl?: string }
export type DepositResult = Awaited<ReturnType<typeof kit.bridge>>

function listen(onEvent?: (e: DepositEvent) => void) {
  // Payload shapes differ per provider and action, so read only the fields we display.
  const handler = (payload: unknown) => {
    const { method, values } = payload as { method?: string; values?: Record<string, unknown> }
    if (!method) return
    const txHash = (values?.txHash ?? values?.transactionHash) as string | undefined
    onEvent?.({ step: method, txHash, explorerUrl: values?.explorerUrl as string | undefined })
  }
  kit.on('*', handler)
  return () => kit.off('*', handler)
}

/**
 * Burns USDC on Arc via CCTP and has Circle's forwarder mint it on Polygon
 * straight to `recipient` (the user's Polymarket bridge deposit address).
 * The user signs the approve and burn on Arc; no POL is needed on Polygon.
 */
export async function depositArcToPolygon(params: {
  provider: EIP1193Provider
  amount: string
  recipient: `0x${string}`
  onEvent?: (e: DepositEvent) => void
}): Promise<DepositResult> {
  const adapter = await createViemAdapterFromProvider({ provider: params.provider })
  const stop = listen(params.onEvent)
  try {
    return await kit.bridge({
      from: { adapter, chain: 'Arc' },
      to: { chain: 'Polygon', recipientAddress: params.recipient, useForwarder: true },
      amount: params.amount,
    })
  } finally {
    stop()
  }
}

/** Resumes a deposit whose burn went through but whose later steps failed. */
export async function retryDeposit(params: {
  provider: EIP1193Provider
  result: DepositResult
  onEvent?: (e: DepositEvent) => void
}): Promise<DepositResult> {
  const adapter = await createViemAdapterFromProvider({ provider: params.provider })
  const stop = listen(params.onEvent)
  try {
    return await kit.retryBridge(params.result, { from: adapter })
  } finally {
    stop()
  }
}
