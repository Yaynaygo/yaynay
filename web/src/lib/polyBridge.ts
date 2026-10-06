import { bridgeHeaders, POLY_BRIDGE_API } from '../config'

/**
 * Returns the EVM bridge deposit address linked to a Polymarket wallet.
 * Native Polygon USDC sent there is swapped to USDC.e and wrapped into pUSD,
 * then credited to that wallet.
 */
export async function getEvmDepositAddress(polymarketWallet: string): Promise<`0x${string}`> {
  const res = await fetch(`${POLY_BRIDGE_API}/deposit`, {
    method: 'POST',
    headers: bridgeHeaders(),
    body: JSON.stringify({ address: polymarketWallet }),
  })
  if (!res.ok) throw new Error(`bridge /deposit failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { address?: { evm?: string } }
  const evm = body.address?.evm
  if (!evm || !/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new Error('bridge /deposit returned no evm address')
  return evm as `0x${string}`
}

export type BridgeTx = {
  status?: string
  fromChainId?: string
  fromAmountBaseUnit?: string
  txHash?: string
  createdTimeMs?: number
  [key: string]: unknown
}

export async function getBridgeStatus(depositAddress: string): Promise<BridgeTx[]> {
  const res = await fetch(`${POLY_BRIDGE_API}/status/${depositAddress}`)
  if (!res.ok) throw new Error(`bridge /status failed: ${res.status}`)
  const body = (await res.json()) as { transactions?: BridgeTx[] }
  return body.transactions ?? []
}
