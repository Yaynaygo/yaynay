// 1-click trading with a Polymarket Session Key (beta): a trading-only key, generated and kept in
// this browser, that the Deposit Wallet owner authorizes once. It signs orders without wallet
// prompts or chain switches, cannot withdraw, and expires after 180 days.
// Loaded on demand together with the Polymarket SDK.
import { createSecureClient, remoteBuilderSigning, SessionKeyKnownScope } from '@polymarket/client'
import { privateKey } from '@polymarket/client/viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { PolyClient } from './polyAccount'
import { BRAND, SIGNER_URL, STORAGE } from '../config'

/** Polymarket's relayer runs one action per wallet at a time; a second one is refused until the first lands. */
export const IN_FLIGHT = /in-flight action/i
const BUSY_MESSAGE = 'Polymarket is still processing your previous action on this wallet. Try again in about a minute.'

export type StoredSessionKey = { privateKey: `0x${string}`; address: string; validUntil: number }

const storageKey = STORAGE.sessionKey

export function loadSessionKey(owner: string, wallet: string): StoredSessionKey | null {
  try {
    const key = JSON.parse(localStorage.getItem(storageKey(owner, wallet)) ?? 'null') as StoredSessionKey | null
    // Stop using it a day before expiry so an order never races the deadline.
    return key && key.validUntil * 1000 > Date.now() + 24 * 3600_000 ? key : null
  } catch {
    return null
  }
}

function saveSessionKey(owner: string, wallet: string, key: StoredSessionKey | null) {
  try {
    if (key) localStorage.setItem(storageKey(owner, wallet), JSON.stringify(key))
    else localStorage.removeItem(storageKey(owner, wallet))
  } catch {
    // Without storage the key lives only for this page.
  }
}

/** A client that signs CLOB orders for `wallet` with the session key; no wallet prompts. */
export async function createSessionClient(key: StoredSessionKey, wallet: string): Promise<PolyClient> {
  return createSecureClient({
    signer: privateKey(key.privateKey),
    wallet,
    apiKey: remoteBuilderSigning({ url: SIGNER_URL }),
  })
}

/** The owner signs one gasless authorization; returns a ready session client. */
export async function enableOneClickTrading(owner: PolyClient, ownerAddress: string, wallet: string) {
  const pk = generatePrivateKey()
  const address = privateKeyToAccount(pk).address
  try {
    const { sessionKey } = await owner.authorizeSessionKey({ address, scopes: [SessionKeyKnownScope.CLOB] })
    const stored = { privateKey: pk, address, validUntil: sessionKey.validUntil }
    saveSessionKey(ownerAddress, wallet, stored)
    return { key: stored, client: await createSessionClient(stored, wallet) }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (IN_FLIGHT.test(message)) throw new Error(BUSY_MESSAGE)
    if (/40[13]|forbidden|unauthori|not (enabled|allowed|permitted)/i.test(message)) {
      throw new Error(
        `1-click trading is not enabled for ${BRAND.name} yet (Polymarket is still approving it). You can keep trading with wallet confirmations.`,
      )
    }
    throw e
  }
}

/** Revokes the key on-chain (one gasless owner signature) and forgets it locally. */
export async function disableOneClickTrading(owner: PolyClient, ownerAddress: string, wallet: string, key: StoredSessionKey) {
  try {
    await owner.revokeSessionKey({ address: key.address })
  } catch (e) {
    if (IN_FLIGHT.test(e instanceof Error ? e.message : String(e))) throw new Error(BUSY_MESSAGE)
    throw e
  } finally {
    // Even if revocation fails, stop using the key here; it still expires on its own.
    saveSessionKey(ownerAddress, wallet, null)
  }
}
