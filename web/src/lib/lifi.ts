import { decodeAbiParameters, formatUnits, isAddress, parseAbiParameters, parseUnits, type Address, type Hex } from 'viem'
import { ARC_USDC, ARC_USDC_DECIMALS } from '../config'

// Top up Arc from other chains through LI.FI's public REST API. Every route ends as USDC on the
// user's own Arc address; quotes are re-checked locally before the wallet is asked to sign.

export const LIFI_API = 'https://li.quest/v1'
export const LIFI_INTEGRATOR = 'yaynay'
export const ARC_CHAIN_ID = 5042
export const NATIVE = '0x0000000000000000000000000000000000000000' as const

export const SLIPPAGE = { stable: 0.005, fx: 0.005, volatile: 0.01 } as const
/** Price feeds of the two legs differ slightly; this much extra drift is tolerated in the min-out check. */
export const PRICE_TOLERANCE = 0.005
/** Above this share of the amount, route fees + gas get a visible warning. */
export const COST_WARN_SHARE = 0.03
/** Above this share, the quote is refused outright. */
export const COST_MAX_SHARE = 0.2

export type TokenKind = 'stable' | 'fx' | 'volatile'

export type SourceToken = {
  address: Address
  symbol: string
  decimals: number
  kind: TokenKind
  /** The chain's gas token (sent as `value`, no approval). */
  native?: boolean
  /** Shown instead of the symbol where a plain symbol would mislead. */
  label?: string
}

export type SourceChain = {
  id: number
  name: string
  /** LiFiDiamond, pinned from LI.FI's docs and /chains; transactions may only go here. */
  diamond: Address
  /** Native balance kept back for gas when the user picks Max on a native token. */
  gasReserve: string
  explorer: string
  /** Same-chain swap on Arc instead of a bridge. */
  sameChain?: boolean
  tokens: SourceToken[]
}

const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as const

const usdc = (address: Address, decimals = 6, symbol = 'USDC'): SourceToken => ({ address, symbol, decimals, kind: 'stable' })
const usdt = (address: Address, decimals = 6, symbol = 'USDT'): SourceToken => ({ address, symbol, decimals, kind: 'stable' })
const dai = (address: Address): SourceToken => ({ address, symbol: 'DAI', decimals: 18, kind: 'stable' })
const native = (symbol: string): SourceToken => ({ address: NATIVE, symbol, decimals: 18, kind: 'volatile', native: true })
const btc = (address: Address, symbol: string, decimals = 8): SourceToken => ({ address, symbol, decimals, kind: 'volatile' })

/**
 * The only tokens a user can top up from, by verified contract address (checked against LI.FI
 * /tokens on 2026-10-06). No free-form token input: long-tail tokens never reach a quote.
 */
export const SOURCES: SourceChain[] = [
  {
    id: 8453,
    name: 'Base',
    diamond: DIAMOND,
    gasReserve: '0.0003',
    explorer: 'https://basescan.org',
    tokens: [
      usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
      usdt('0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'),
      dai('0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'),
      native('ETH'),
      btc('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC'),
    ],
  },
  {
    id: 42161,
    name: 'Arbitrum',
    diamond: DIAMOND,
    gasReserve: '0.0003',
    explorer: 'https://arbiscan.io',
    tokens: [
      usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
      usdt('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 'USDT0'),
      dai('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'),
      native('ETH'),
      btc('0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 'WBTC'),
      btc('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC'),
    ],
  },
  {
    id: 10,
    name: 'Optimism',
    diamond: DIAMOND,
    gasReserve: '0.0003',
    explorer: 'https://optimistic.etherscan.io',
    tokens: [
      usdc('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
      usdt('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'),
      usdt('0x01bFF41798a0BcF287b996046Ca68b395DbC1071', 6, 'USDT0'),
      dai('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'),
      native('ETH'),
      btc('0x68f180fcCe6836688e9084f035309E29Bf0A2095', 'WBTC'),
    ],
  },
  {
    id: 137,
    name: 'Polygon',
    diamond: DIAMOND,
    gasReserve: '1',
    explorer: 'https://polygonscan.com',
    tokens: [
      usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
      usdc('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6, 'USDC.e'),
      usdt('0xc2132D05D31c914a87C6611C10748AEb04B58e8F'),
      dai('0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'),
      native('POL'),
      btc('0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', 'WBTC'),
    ],
  },
  {
    id: 1,
    name: 'Ethereum',
    diamond: DIAMOND,
    gasReserve: '0.003',
    explorer: 'https://etherscan.io',
    tokens: [
      usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
      usdt('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
      dai('0x6B175474E89094C44Da98b954EedeAC495271d0F'),
      native('ETH'),
      btc('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC'),
      btc('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC'),
    ],
  },
  {
    id: 56,
    name: 'BNB Chain',
    diamond: DIAMOND,
    gasReserve: '0.002',
    explorer: 'https://bscscan.com',
    tokens: [
      // BNB Chain's bridged stablecoins use 18 decimals.
      usdt('0x55d398326f99059fF775485246999027B3197955', 18),
      usdc('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
      dai('0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3'),
      native('BNB'),
    ],
  },
  {
    id: 4217,
    name: 'Tempo',
    diamond: '0x2cAcAE8e22418E65dcf7651c67aEbe6288EB8243',
    gasReserve: '0',
    explorer: 'https://explore.tempo.xyz',
    // Tempo has no native coin; its stablecoins are TIP-20 tokens with an ERC-20 interface.
    tokens: [
      usdc('0x20C000000000000000000000b9537d11c60E8b50', 6, 'USDC.e'),
      usdt('0x20C00000000000000000000014f22CA97301EB73', 6, 'USDT0'),
      { address: '0x20C0000000000000000000000000000000000000', symbol: 'pathUSD', decimals: 6, kind: 'stable' },
    ],
  },
  {
    id: ARC_CHAIN_ID,
    name: 'Arc',
    diamond: '0xA4072583658Fae592A3506A42431cb6316a8d40b',
    gasReserve: '0',
    explorer: 'https://explorer.arc.io',
    sameChain: true,
    tokens: [
      { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', symbol: 'EURC', decimals: 6, kind: 'fx', label: 'Swap EURC to USDC (stablecoin FX)' },
      { address: '0x128cC466B61f542da60c70e3aA11c10e19B84EDB', symbol: 'WETH', decimals: 18, kind: 'volatile' },
      btc('0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', 'cirBTC'),
    ],
  },
]

export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export function findSource(chainId: number): SourceChain | undefined {
  return SOURCES.find((s) => s.id === chainId)
}

/** The allowlisted token at `address` on `chainId`, or undefined. Never matches by symbol. */
export function findToken(chainId: number, address: string): SourceToken | undefined {
  return findSource(chainId)?.tokens.find((t) => sameAddress(t.address, address))
}

export const defaultSlippage = (t: SourceToken) => SLIPPAGE[t.kind]

/** Parses a user-typed amount for `decimals`; null when it isn't a positive number with at most that many decimals. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const re = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`)
  if (!re.test(text)) return null
  const v = parseUnits(text, decimals)
  return v > 0n ? v : null
}

// ---------- API types (only the fields we use) ----------

export type LifiToken = {
  address: string
  chainId: number
  symbol: string
  decimals: number
  name?: string
  logoURI?: string
  priceUSD?: string
}

export type LifiChain = { id: number; key: string; name: string; logoURI?: string; diamondAddress?: string }

export type FeeCost = {
  name: string
  description?: string
  amount: string
  amountUSD?: string
  percentage?: string
  included?: boolean
  token: LifiToken
  feeSplit?: { lifiFee?: string; integratorFee?: string }
}

export type GasCost = { type?: string; amount: string; amountUSD?: string; token: LifiToken }

export type LifiQuote = {
  id?: string
  type?: string
  tool: string
  toolDetails?: { key: string; name: string; logoURI?: string }
  action: {
    fromChainId: number
    toChainId: number
    fromToken: LifiToken
    toToken: LifiToken
    fromAmount: string
    fromAddress?: string
    toAddress?: string
    slippage?: number
  }
  estimate: {
    tool?: string
    approvalAddress?: string
    fromAmount: string
    toAmount: string
    toAmountMin: string
    fromAmountUSD?: string
    toAmountUSD?: string
    executionDuration?: number
    feeCosts?: FeeCost[]
    gasCosts?: GasCost[]
  }
  includedSteps?: {
    type?: string
    tool: string
    toolDetails?: { name: string }
    action?: { fromToken: LifiToken; toToken?: LifiToken; fromAmount: string }
    estimate?: { toAmount?: string; toAmountMin?: string }
  }[]
  integrator?: string
  transactionRequest?: {
    to?: string
    from?: string
    data?: string
    value?: string
    chainId?: number
    gasLimit?: string
    gasPrice?: string
  }
}

export type LifiStatusResponse = {
  status: 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED'
  substatus?: string
  substatusMessage?: string
  tool?: string
  lifiExplorerLink?: string
  sending?: { txHash?: string; chainId?: number }
  receiving?: { txHash?: string; txLink?: string; chainId?: number; amount?: string; token?: LifiToken }
  toAddress?: string
}

// ---------- API calls ----------

async function getJson<T>(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const res = await fetch(`${LIFI_API}${path}?${qs}`, { signal })
  const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null
  if (!res.ok || !body) {
    const msg = body?.message ?? `LI.FI ${path} failed (${res.status})`
    throw new LifiError(msg, res.status, res.status === 429 ? retryAfterMs(res.headers.get('retry-after'), msg) : undefined)
  }
  return body
}

export class LifiError extends Error {
  status: number
  /** For 429s: how long LI.FI asked us to wait, when it said so. */
  retryAfterMs?: number
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.name = 'LifiError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

const UNIT_MS: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000 }

/** Reads a Retry-After header (seconds) or LI.FI's "retry in 1 hour" message; undefined when neither says. */
export function retryAfterMs(header: string | null, message: string): number | undefined {
  const secs = header !== null && header.trim() !== '' ? Number(header) : NaN
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  const m = /retry in (an?|\d+)\s*(second|minute|hour)s?/i.exec(message)
  if (!m) return undefined
  const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1])
  return n * UNIT_MS[m[2].toLowerCase()]
}

/** LI.FI metadata (name, logo, diamond) for our curated source chains, in our order. */
export async function fetchSourceChains(signal?: AbortSignal): Promise<Map<number, LifiChain>> {
  const { chains } = await getJson<{ chains: LifiChain[] }>('/chains', { chainTypes: 'EVM' }, signal)
  const byId = new Map<number, LifiChain>()
  for (const c of chains) if (findSource(c.id)) byId.set(c.id, c)
  return byId
}

/**
 * A source chain is usable only when LI.FI's advertised diamond matches the pinned one, so a
 * changed or spoofed deployment can't silently redirect approvals.
 */
export function chainDiamondOk(source: SourceChain, meta?: LifiChain): boolean {
  return !meta?.diamondAddress || sameAddress(meta.diamondAddress, source.diamond)
}

/** Logo and price for each allowlisted token on a chain; tokens LI.FI doesn't know (or reports differently) are dropped. */
export async function fetchSourceTokens(source: SourceChain, signal?: AbortSignal): Promise<(SourceToken & { logoURI?: string; priceUSD?: number })[]> {
  const results = await Promise.all(
    source.tokens.map((t) =>
      getJson<LifiToken>('/token', { chain: source.id, token: t.address }, signal)
        .then((m) => ({ t, m }))
        .catch(() => ({ t, m: null })),
    ),
  )
  return results.flatMap(({ t, m }) => {
    if (m && !tokenMetaMatches(t, m, source.id)) return []
    const price = m?.priceUSD ? Number(m.priceUSD) : undefined
    return [{ ...t, logoURI: m?.logoURI, priceUSD: Number.isFinite(price) ? price : undefined }]
  })
}

/** LI.FI's token metadata must describe exactly the allowlisted token. */
export function tokenMetaMatches(t: SourceToken, m: LifiToken, chainId: number): boolean {
  return m.chainId === chainId && sameAddress(m.address, t.address) && m.decimals === t.decimals
}

export type QuoteRequest = {
  source: SourceChain
  token: SourceToken
  amount: bigint
  /** The connected wallet: sender on the source chain and recipient on Arc. */
  user: Address
  slippage: number
}

export function quoteParams(r: QuoteRequest): Record<string, string | number> {
  return {
    fromChain: r.source.id,
    toChain: ARC_CHAIN_ID,
    fromToken: r.token.address,
    toToken: ARC_USDC,
    fromAmount: r.amount.toString(),
    fromAddress: r.user,
    toAddress: r.user,
    slippage: r.slippage,
    integrator: LIFI_INTEGRATOR,
    // No integrator fee: we never pass `fee`, and checkQuote rejects any integrator share.
  }
}

// LI.FI allows 75 anonymous quotes per two hours per IP. Once this network has used them, quotes go
// through our server-side key (/api/lifi/quote) until the window resets. The proxied quote is the same
// LI.FI response and goes through the same checkQuote/calldata checks before anything is signed.
let directBlockedUntil = 0
let proxyAvailable: boolean | null = null

async function proxyQuote(r: QuoteRequest, signal?: AbortSignal): Promise<LifiQuote | null> {
  if (proxyAvailable === false) return null
  const { ensureApiSession } = await import('./apiSession')
  await ensureApiSession()
  const res = await fetch('/api/lifi/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(quoteParams(r)),
    signal,
  })
  if (res.status === 404) {
    proxyAvailable = false
    return null
  }
  proxyAvailable = true
  const body = (await res.json().catch(() => null)) as (LifiQuote & { message?: string }) | null
  if (!res.ok || !body) {
    const msg = body?.message ?? `LI.FI /quote failed (${res.status})`
    throw new LifiError(msg, res.status, res.status === 429 ? retryAfterMs(res.headers.get('retry-after'), msg) : undefined)
  }
  return body
}

export async function fetchQuote(r: QuoteRequest, signal?: AbortSignal): Promise<LifiQuote> {
  let limited: LifiError | null = null
  if (Date.now() >= directBlockedUntil) {
    try {
      return await getJson<LifiQuote>('/quote', quoteParams(r), signal)
    } catch (e) {
      if (!(e instanceof LifiError) || e.status !== 429) throw e
      directBlockedUntil = Date.now() + (e.retryAfterMs ?? 60 * 60_000)
      limited = e
    }
  }
  const viaProxy = await proxyQuote(r, signal)
  if (viaProxy) return viaProxy
  throw limited ?? new LifiError('LI.FI rate limit', 429, Math.max(0, directBlockedUntil - Date.now()))
}

export async function fetchStatus(
  p: { txHash: string; fromChainId: number; tool?: string },
  signal?: AbortSignal,
): Promise<LifiStatusResponse | null> {
  const params: Record<string, string | number> = { txHash: p.txHash, fromChain: p.fromChainId, toChain: ARC_CHAIN_ID }
  if (p.tool) params.bridge = p.tool
  try {
    return await getJson<LifiStatusResponse>('/status', params, signal)
  } catch (e) {
    // Freshly sent transactions are unknown for a while.
    if (e instanceof LifiError && e.status === 404) return null
    throw e
  }
}

// ---------- safety checks (pure) ----------

const units = (amount: string | bigint, decimals: number) => Number(formatUnits(BigInt(amount), decimals))
const usd = (s?: string) => {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/** The input's USD value: stablecoins at face value, everything else at the quoted price. */
/**
 * Gas limit to send with a route. LI.FI's `gasLimit` is computed with Ethereum gas costs and came up
 * short on Tempo (596,700 quoted vs 667,618 needed, so the transfer ran out of gas and reverted).
 * Prefer our own estimate from the source chain plus 30%, never below LI.FI's figure; with no
 * estimate at all, add 50% to LI.FI's.
 */
export function gasWithBuffer(estimate: bigint | null, quoted?: string): bigint | undefined {
  const lifi = quoted && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(quoted) ? BigInt(quoted) : null
  if (estimate !== null && estimate > 0n) {
    const padded = (estimate * 13n) / 10n
    return lifi !== null && lifi > padded ? lifi : padded
  }
  return lifi !== null ? (lifi * 3n) / 2n : undefined
}

export function inputUsd(q: LifiQuote, token: SourceToken, refPriceUSD?: number): number {
  const amount = units(q.action.fromAmount, token.decimals)
  if (token.kind === 'stable') return amount
  const price = refPriceUSD ?? Number(q.action.fromToken.priceUSD)
  return Number.isFinite(price) && price > 0 ? amount * price : NaN
}

export type QuoteBreakdown = {
  toolName: string
  /** Every protocol the route touches (swaps and bridge), for display. */
  route: string[]
  inUsd: number
  toAmount: number
  toAmountMin: number
  fees: { name: string; usd: number; included: boolean }[]
  gas: { usd: number; symbol: string }
  /** Fees taken from the amount (already reflected in toAmount). */
  includedFeesUsd: number
  /** All fees plus source-chain gas. */
  costUsd: number
  costShare: number
  seconds: number
}

export function breakdown(q: LifiQuote, token: SourceToken, refPriceUSD?: number): QuoteBreakdown {
  const fees = (q.estimate.feeCosts ?? []).map((f) => ({
    name: f.name === 'LIFI Fixed Fee' ? 'LI.FI fee' : f.name,
    usd: usd(f.amountUSD),
    included: f.included !== false,
  }))
  const gasUsd = (q.estimate.gasCosts ?? []).reduce((s, g) => s + usd(g.amountUSD), 0)
  const includedFeesUsd = fees.filter((f) => f.included).reduce((s, f) => s + f.usd, 0)
  const costUsd = fees.reduce((s, f) => s + f.usd, 0) + gasUsd
  const inUsd = inputUsd(q, token, refPriceUSD)
  const steps = (q.includedSteps ?? []).filter((s) => s.tool !== 'feeCollection')
  return {
    toolName: q.toolDetails?.name ?? q.tool,
    route: steps.map((s) => s.toolDetails?.name ?? s.tool),
    inUsd,
    toAmount: units(q.estimate.toAmount, ARC_USDC_DECIMALS),
    toAmountMin: units(q.estimate.toAmountMin, ARC_USDC_DECIMALS),
    fees,
    gas: { usd: gasUsd, symbol: q.estimate.gasCosts?.[0]?.token.symbol ?? '' },
    includedFeesUsd,
    costUsd,
    costShare: inUsd > 0 ? costUsd / inUsd : NaN,
    seconds: q.estimate.executionDuration ?? 0,
  }
}

export type QuoteExpectation = QuoteRequest & { refPriceUSD?: number }

/**
 * Everything wrong with a quote, as user-readable sentences; empty means it is safe to sign.
 * Guards against misrouted funds (wrong chain, token or recipient), a transaction to anything
 * but LI.FI's diamond, unbounded approvals, hidden integrator fees and a poor minimum output.
 */
export function checkQuote(q: LifiQuote, e: QuoteExpectation): string[] {
  const problems: string[] = []
  const a = q.action
  const tx = q.transactionRequest
  if (!a || !q.estimate) return ['The quote is incomplete.']
  if (!findToken(e.source.id, e.token.address)) problems.push('That token is not on the supported list.')

  if (a.fromChainId !== e.source.id) problems.push('The quote starts on a different chain.')
  if (a.toChainId !== ARC_CHAIN_ID) problems.push('The quote does not end on Arc.')
  if (!sameAddress(a.fromToken?.address, e.token.address)) problems.push('The quote spends a different token.')
  if (!sameAddress(a.toToken?.address, ARC_USDC) || a.toToken?.decimals !== ARC_USDC_DECIMALS) {
    problems.push('The quote does not deliver USDC on Arc.')
  }
  if (a.fromAmount !== e.amount.toString() || q.estimate.fromAmount !== e.amount.toString()) {
    problems.push('The quote is for a different amount.')
  }
  if (!sameAddress(a.fromAddress, e.user)) problems.push('The quote is for a different sender.')
  if (!sameAddress(a.toAddress, e.user)) problems.push('The quote would send the funds to another address.')
  if (a.slippage !== undefined && a.slippage > e.slippage + 1e-9) problems.push('The quote allows more slippage than you set.')

  if (!tx?.to || !tx.data) problems.push('The quote has no transaction to sign.')
  else {
    if (tx.chainId !== e.source.id) problems.push('The transaction targets a different chain.')
    if (!sameAddress(tx.to, e.source.diamond)) problems.push("The transaction is not addressed to LI.FI's contract.")
    if (tx.from && !sameAddress(tx.from, e.user)) problems.push('The transaction is for a different sender.')
    const value = BigInt(tx.value ?? '0')
    if (e.token.native ? value !== e.amount : value !== 0n) problems.push('The transaction sends an unexpected amount of the gas coin.')
    problems.push(...checkCalldata(q, e))
  }
  if (!e.token.native) {
    const spender = q.estimate.approvalAddress
    if (!spender || !isAddress(spender) || !sameAddress(spender, e.source.diamond) || !sameAddress(spender, tx?.to)) {
      problems.push("The approval would go to a contract other than LI.FI's.")
    }
  }

  for (const f of q.estimate.feeCosts ?? []) {
    if (f.feeSplit?.integratorFee && BigInt(f.feeSplit.integratorFee) !== 0n) problems.push('The quote includes an integrator fee.')
  }

  const toAmount = BigInt(q.estimate.toAmount)
  const toMin = BigInt(q.estimate.toAmountMin)
  if (toMin <= 0n || toMin > toAmount) problems.push('The quote has an invalid minimum output.')
  else {
    const b = breakdown(q, e.token, e.refPriceUSD)
    if (!Number.isFinite(b.inUsd) || b.inUsd <= 0) problems.push('The input could not be priced.')
    else {
      if (b.costShare > COST_MAX_SHARE) problems.push(`Fees and gas would take ${(b.costShare * 100).toFixed(0)}% of the amount.`)
      // Arc USDC counts at $1. What arrives at worst must be the input minus the fees the route
      // itemises, minus the slippage the user accepted (plus a small allowance for price-feed drift).
      const floor = (b.inUsd - b.includedFeesUsd) * (1 - e.slippage - PRICE_TOLERANCE)
      if (b.toAmountMin < floor) problems.push('The minimum you would receive is too low for this amount.')
    }
  }
  return [...new Set(problems)]
}

// ---------- calldata (what the wallet actually signs) ----------

/** LI.FI's ILiFi.BridgeData, the first argument of every startBridgeTokensVia* / swapAndStartBridgeTokensVia* call. */
const BRIDGE_DATA = parseAbiParameters(
  '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)',
)
/** GenericSwapFacet(V3): swapTokens*(transactionId, integrator, referrer, receiver, minAmountOut, swapData). */
const SWAP_HEAD = parseAbiParameters('bytes32, string, string, address, uint256')
const SWAP_DATA = '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)'
const SWAP_MULTI = parseAbiParameters(`bytes32, string, string, address, uint256, ${SWAP_DATA}[]`)
const SWAP_SINGLE = parseAbiParameters(`bytes32, string, string, address, uint256, ${SWAP_DATA}`)

/** Same-chain swap entry points of LI.FI's diamond, by selector. */
export const SWAP_SELECTORS: Record<string, 'multi' | 'single'> = {
  '0x4630a0d8': 'multi', // swapTokensGeneric
  '0x5fd9ae2e': 'multi', // swapTokensMultipleV3ERC20ToERC20
  '0x2c57e884': 'multi', // swapTokensMultipleV3ERC20ToNative
  '0x736eac0b': 'multi', // swapTokensMultipleV3NativeToERC20
  '0x4666fc80': 'single', // swapTokensSingleV3ERC20ToERC20
  '0x733214a3': 'single', // swapTokensSingleV3ERC20ToNative
  '0xaf7060fd': 'single', // swapTokensSingleV3NativeToERC20
}

const word = (addr: string) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/**
 * Decodes the transaction the wallet will sign and checks it against the quote: funds go to the
 * user, on Arc, with no destination call, and the on-chain minimum matches the quoted one.
 */
export function checkCalldata(q: LifiQuote, e: QuoteExpectation): string[] {
  const data = q.transactionRequest?.data
  if (!data || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return ['The transaction data is missing.']
  if (!data.toLowerCase().includes(word(e.user))) return ['The transaction does not name your address.']
  const selector = data.slice(0, 10).toLowerCase()
  const args = `0x${data.slice(10)}` as Hex
  const problems: string[] = []

  if (e.source.sameChain) {
    const kind = SWAP_SELECTORS[selector]
    if (!kind) return ['The transaction is not a LI.FI swap we recognise.']
    try {
      const [, , , receiver, minOut] = decodeAbiParameters(SWAP_HEAD, args)
      if (!sameAddress(receiver, e.user)) problems.push('The swap would pay out to another address.')
      if (minOut < BigInt(q.estimate.toAmountMin)) problems.push("The swap's on-chain minimum is lower than quoted.")
      const swaps = kind === 'multi' ? decodeAbiParameters(SWAP_MULTI, args)[5] : [decodeAbiParameters(SWAP_SINGLE, args)[5]]
      const first = swaps[0]
      const last = swaps[swaps.length - 1]
      if (!first || !sameAddress(first.sendingAssetId, e.token.address) || first.fromAmount !== e.amount) {
        problems.push('The swap spends a different token or amount.')
      }
      if (!last || !sameAddress(last.receivingAssetId, ARC_USDC)) problems.push('The swap does not end in USDC.')
    } catch {
      return ['The swap transaction could not be decoded.']
    }
    return problems
  }

  // Bridges: every LI.FI bridge facet takes BridgeData first, so decode just that and refuse
  // anything that doesn't decode into a transfer to this user on Arc via the quoted bridge.
  let b
  try {
    ;[b] = decodeAbiParameters(BRIDGE_DATA, args)
  } catch {
    return ['The bridge transaction could not be decoded.']
  }
  if (!sameAddress(b.receiver, e.user)) problems.push('The bridge would deliver to another address.')
  if (b.destinationChainId !== BigInt(ARC_CHAIN_ID)) problems.push('The bridge transaction does not go to Arc.')
  if (b.hasDestinationCall) problems.push('The bridge transaction would run extra code on Arc.')
  if (b.bridge !== q.tool) problems.push('The transaction uses a different bridge than quoted.')
  if (!b.hasSourceSwaps && !sameAddress(b.sendingAssetId, e.token.address)) problems.push('The bridge sends a different token.')

  // minAmount is in the bridged asset's units on the source chain (after any source swap). Valued
  // in USD it must cover the quoted minimum on Arc, and can't exceed what goes in.
  const leg = (q.includedSteps ?? []).find((st) => st.type === 'cross')
  if (!leg?.action || !sameAddress(leg.action.fromToken.address, b.sendingAssetId)) {
    problems.push('The bridge leg of the quote does not match the transaction.')
  } else {
    const t = leg.action.fromToken
    const price = findToken(e.source.id, t.address)?.kind === 'stable' ? 1 : Number(t.priceUSD)
    const minUsd = units(b.minAmount, t.decimals) * price
    const toMinUsd = units(q.estimate.toAmountMin, ARC_USDC_DECIMALS)
    const inUsd = inputUsd(q, e.token, e.refPriceUSD)
    if (!Number.isFinite(minUsd) || minUsd < toMinUsd * (1 - PRICE_TOLERANCE) || minUsd > inUsd * (1 + PRICE_TOLERANCE)) {
      problems.push("The bridge's on-chain minimum doesn't match the quote.")
    }
  }
  return problems
}

export class UnsafeQuoteError extends Error {
  problems: string[]
  constructor(problems: string[]) {
    super(`Stopped before signing: ${problems[0]}`)
    this.name = 'UnsafeQuoteError'
    this.problems = problems
  }
}

export function assertSafeQuote(q: LifiQuote, e: QuoteExpectation): void {
  const problems = checkQuote(q, e)
  if (problems.length) throw new UnsafeQuoteError(problems)
}

/** How much to approve, if anything: exactly the amount, only when the current allowance is short. */
export function approvalNeeded(token: SourceToken, allowance: bigint, amount: bigint): bigint | null {
  if (token.native) return null
  return allowance >= amount ? null : amount
}

/** Ethereum USDT reverts when changing a non-zero allowance; it has to be reset to 0 first. */
export function needsAllowanceReset(chainId: number, token: SourceToken, allowance: bigint): boolean {
  return chainId === 1 && sameAddress(token.address, '0xdAC17F958D2ee523a2206206994597C13D831ec7') && allowance > 0n
}

// ---------- status ----------

export type TopUpPhase = 'pending' | 'done' | 'partial' | 'refunded' | 'failed'

export function interpretStatus(s: LifiStatusResponse | null, txHash: string): { phase: TopUpPhase; received?: number; arcTx?: string; message?: string } {
  // LI.FI can answer for a different transfer when it can't find ours; only trust a matching hash.
  if (!s || (s.sending?.txHash && !sameAddress(s.sending.txHash, txHash))) return { phase: 'pending' }
  if (s.status === 'FAILED' || s.status === 'INVALID') return { phase: 'failed', message: s.substatusMessage }
  if (s.status !== 'DONE') return { phase: 'pending', message: s.substatusMessage }
  if (s.substatus === 'REFUNDED') return { phase: 'refunded', message: s.substatusMessage }
  const r = s.receiving
  const gotUsdc = r?.chainId === ARC_CHAIN_ID && sameAddress(r?.token?.address, ARC_USDC)
  const received = gotUsdc && r?.amount ? units(r.amount, ARC_USDC_DECIMALS) : undefined
  if (s.substatus === 'PARTIAL' || (r?.token && !gotUsdc)) {
    return { phase: 'partial', arcTx: r?.txHash, message: s.substatusMessage ?? `You received ${r?.token?.symbol ?? 'another token'} instead of USDC.` }
  }
  return { phase: 'done', received, arcTx: r?.txHash }
}

/**
 * Picks the Arc USDC transfer that is our top-up when LI.FI can't track it (its status API doesn't
 * know Tempo transactions): a transfer to the user after the send, within a few percent of what the
 * route promised. Bridges deliver from a relayer, so the sender can't be matched; amount and time can.
 */
export function matchArrival(
  transfers: { value: bigint; timestamp: number; txHash: string }[],
  p: { expected: number; sinceSec: number },
): { amount: number; txHash: string } | null {
  const lo = p.expected * 0.95
  const hi = p.expected * 1.05
  for (const t of [...transfers].sort((a, b) => a.timestamp - b.timestamp)) {
    const amount = units(t.value, ARC_USDC_DECIMALS)
    // Strictly after the send: a bridge can't deliver before the source transaction exists.
    if (t.timestamp >= p.sinceSec && amount >= lo && amount <= hi) return { amount, txHash: t.txHash }
  }
  return null
}

// ---------- in-flight top-up (survives a reload) ----------

export const PENDING_TOPUP_KEY = 'yaynay:pending-topup'

export type PendingTopUp = {
  user: string
  txHash: string
  fromChainId: number
  tool: string
  toolName: string
  symbol: string
  amount: string
  expected: string
  startedAt: number
}

/**
 * A wallet "speed up" replaces the source transaction with a new hash (keep tracking that one);
 * a "cancel" replaces it with a no-op, so nothing was sent (stop tracking).
 */
export function afterReplacement(p: PendingTopUp, reason: 'replaced' | 'repriced' | 'cancelled', newHash: string): PendingTopUp | null {
  return reason === 'cancelled' ? null : { ...p, txHash: newHash }
}

/** A saved top-up for this wallet that is recent enough to keep tracking. */
export function validPending(p: PendingTopUp | null, user: string | undefined, now = Date.now()): PendingTopUp | null {
  if (!p || !user || !sameAddress(p.user, user) || now - p.startedAt > 24 * 3600_000) return null
  return p
}
