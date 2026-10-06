import { createSecureClient, remoteBuilderSigning, type SecureClient } from '@polymarket/client'
import { signerFrom } from '@polymarket/client/viem'
import { createWalletClient, custom, type EIP1193Provider } from 'viem'
import { polygon, SIGNER_URL } from '../config'

export type PolyClient = SecureClient

/**
 * Opens a Polymarket session for the connected EOA and returns its deterministic Deposit Wallet,
 * which holds pUSD and positions. With saved `credentials` no signature is needed; otherwise the
 * user signs one off-chain login message (wallet must be on Polygon for that).
 * Relayer calls (wallet deploy, approvals, transfers) are gasless and authorized by our builder
 * credentials through /api/builder/sign; the keys never reach the browser.
 */
export async function connectPolymarket(params: {
  provider: EIP1193Provider
  address: `0x${string}`
  credentials?: PolyClient['credentials']
}) {
  // Built directly on the provider so it works whichever chain the wallet is on right now.
  const walletClient = createWalletClient({ account: params.address, chain: polygon, transport: custom(params.provider) })
  const client = await createSecureClient({
    signer: signerFrom(walletClient),
    apiKey: remoteBuilderSigning({ url: SIGNER_URL }),
    ...(params.credentials ? { credentials: params.credentials } : {}),
  })
  return { client, wallet: client.account.wallet }
}

/** Deploys the Deposit Wallet if needed and grants trading approvals, all gasless. */
export async function ensureTradingReady(client: PolyClient) {
  const state = await client.fetchTradingApprovalsState()
  if (!state.isFullyApproved) await client.setupTradingApprovals()
}
