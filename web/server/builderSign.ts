import { builderSignature } from './hmac.ts'

export type BuilderEnv = {
  POLYMARKET_BUILDER_API_KEY?: string
  POLYMARKET_BUILDER_SECRET?: string
  POLYMARKET_BUILDER_PASSPHRASE?: string
}

// The SDK sends every relayer request and every CLOB request through this signer once a
// builder key is configured. Reads are allowed except builder-scoped ones; writes only for the
// user's own trading, API-key and relayer calls. Builder-account management is never signed, so a
// caller cannot list, create or revoke our builder keys or read our builder data.
const DENIED_PREFIXES = ['/auth/builder-api-key', '/builder', '/v1/builder']

// Relayer routes that execute an on-chain transaction for the user's Deposit Wallet; these count
// against Polymarket's daily relayer quota.
const RELAYER_TX_ROUTES = new Set(['/submit', '/v1/session-signers/authorizations', '/v1/session-signers/revocations'])

const WRITE_ROUTES: Record<string, string[]> = {
  // Relayer: wallet deploy, approvals, transfers, redemptions, 1-click trading keys.
  POST: [...RELAYER_TX_ROUTES, '/auth/api-key', '/order', '/orders'],
  // CLOB: the user's own L2 API key and cancellations (also signed by the user).
  DELETE: ['/auth/api-key', '/order', '/orders', '/cancel-all', '/cancel-market-orders'],
}

// YayNay users always trade from Polymarket Deposit Wallets.
const RELAYER_TYPES = new Set(['WALLET', 'WALLET-CREATE'])

export class SignError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export type SignRequest = {
  method: string
  path: string
  route: string
  body?: string
  /** True for anything other than GET; these count against our daily limits. */
  isWrite: boolean
  /** True for relayer transactions (Polymarket's daily relayer quota). */
  isRelayerTx: boolean
  /** Signer or wallet of a relayer transaction, used for per-wallet limits. */
  relayerFrom?: string
}

/** Validates the SDK's signing request without signing it. */
export function parseSignRequest(input: unknown): SignRequest {
  const { method: rawMethod, path, body } = (input ?? {}) as { method?: unknown; path?: unknown; body?: unknown }
  if (typeof rawMethod !== 'string' || typeof path !== 'string' || !path.startsWith('/')) {
    throw new SignError('method and path are required', 400)
  }
  if (body !== undefined && typeof body !== 'string') throw new SignError('body must be a string', 400)

  const method = rawMethod.toUpperCase()
  const route = path.split('?')[0]
  if (DENIED_PREFIXES.some((prefix) => route.startsWith(prefix))) throw new SignError(`refusing to sign ${route}`, 403)

  if (method === 'GET') return { method, path, route, body, isWrite: false, isRelayerTx: false }
  if (!WRITE_ROUTES[method]?.includes(route)) throw new SignError(`refusing to sign ${method} ${route}`, 403)

  let relayerFrom: string | undefined
  if (route === '/submit') {
    let tx: { type?: unknown; from?: unknown }
    try {
      tx = JSON.parse(body ?? '')
    } catch {
      throw new SignError('relayer body must be JSON', 400)
    }
    if (typeof tx.type !== 'string' || !RELAYER_TYPES.has(tx.type)) {
      throw new SignError(`refusing relayer transaction type ${String(tx.type)}`, 403)
    }
    if (typeof tx.from === 'string') relayerFrom = tx.from.toLowerCase()
  } else if (RELAYER_TX_ROUTES.has(route)) {
    try {
      const { walletAddress } = JSON.parse(body ?? '') as { walletAddress?: unknown }
      if (typeof walletAddress === 'string') relayerFrom = walletAddress.toLowerCase()
    } catch {
      throw new SignError('relayer body must be JSON', 400)
    }
  }
  return { method, path, route, body, isWrite: true, isRelayerTx: RELAYER_TX_ROUTES.has(route), relayerFrom }
}

/** Returns the POLY_BUILDER_* headers for a request that passed `parseSignRequest`. */
export async function signBuilderRequest(req: SignRequest, env: BuilderEnv) {
  const { POLYMARKET_BUILDER_API_KEY: key, POLYMARKET_BUILDER_SECRET: secret, POLYMARKET_BUILDER_PASSPHRASE: passphrase } = env
  if (!key || !secret || !passphrase) throw new SignError('builder credentials are not configured', 500)

  const timestamp = Math.floor(Date.now() / 1000)
  return {
    POLY_BUILDER_API_KEY: key,
    POLY_BUILDER_PASSPHRASE: passphrase,
    POLY_BUILDER_SIGNATURE: await builderSignature(secret, timestamp, req.method, req.path, req.body),
    POLY_BUILDER_TIMESTAMP: `${timestamp}`,
  }
}
