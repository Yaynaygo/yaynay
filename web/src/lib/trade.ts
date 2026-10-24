import { AssetType, OrderSide, production } from '@polymarket/client'
import { updateBalanceAllowance } from '@polymarket/client/actions'
import { BUILDER_CODE, HAS_BUILDER_CODE } from '../config'
import type { PolyClient } from './polyAccount'
import type { ProtocolVersion } from './protocol'

// Polymarket's production contract addresses, as shipped in the SDK. The public type hides the
// field, but it is present at runtime (it is what the SDK itself uses).
const CONTRACTS = (production as unknown as { contracts: Record<string, `0x${string}`> }).contracts

function builderCode(): string | undefined {
  return HAS_BUILDER_CODE ? BUILDER_CODE : undefined
}

type OrderResponse = Awaited<ReturnType<PolyClient['placeMarketOrder']>>

// Plain-language messages for the CLOB's rejection codes.
const ORDER_ERRORS: Record<string, string> = {
  fak_not_filled: 'Nothing filled at your price limit. The price moved or there is not enough liquidity; try a smaller amount.',
  fok_not_filled: 'The whole order could not be filled at your price limit.',
  insufficient_balance_or_allowance: 'Not enough pUSD (or shares) in your Polymarket wallet for this order, including fees.',
  market_not_ready: 'This market is not accepting orders right now.',
  invalid_expiration: 'The order expired before it reached Polymarket; check your computer clock and try again.',
  invalid_nonce: 'Polymarket rejected the order nonce; reload the page and try again.',
  unmatched: 'The order could not be matched.',
}

function check(response: OrderResponse) {
  if (!response.ok) {
    const friendly = ORDER_ERRORS[response.code]
    throw new Error(friendly ? `${friendly} (${response.code})` : `Order rejected (${response.code}): ${response.message}`)
  }
  return response
}

// The CLOB caches each account's balance and allowances. After a deposit, sale or redemption the
// cache can lag the chain and the order is rejected as "not enough balance / allowance". Refresh
// the cache and retry once.
/**
 * Who signs what: `trade` signs orders (a 1-click session key, or the owner's wallet); approvals
 * always need the Deposit Wallet owner, after `prepareOwner` (signer session + Polygon).
 */
export type TradeSigners = { trade: PolyClient; owner: PolyClient; prepareOwner: () => Promise<void> }

async function withBalanceSync(
  signers: TradeSigners,
  sync: { assetType: AssetType; assetId?: string },
  place: () => Promise<OrderResponse>,
  onStatus?: (text: string) => void,
) {
  const client = signers.owner
  // The CLOB reports balance/allowance problems either as a rejected order response or as an
  // HTTP 400 that the SDK throws; handle both the same way.
  const attempt = async (): Promise<OrderResponse | Error> => {
    try {
      return await place()
    } catch (e) {
      if (e instanceof Error) return e
      throw e
    }
  }
  const problem = (r: OrderResponse | Error): string | null => {
    const message = r instanceof Error ? r.message : r.ok ? '' : r.code === 'insufficient_balance_or_allowance' ? r.message : ''
    return /not enough balance|allowance/i.test(message) ? message : null
  }

  let result = await attempt()
  const message = problem(result)
  if (message) {
    // Neg-risk (multi-outcome) markets need pUSD → negRiskAdapter, which the SDK's
    // setupTradingApprovals does not grant. Grant the missing approval once, gaslessly, then retry.
    const spender = missingApprovalSpender(message)
    if (spender) {
      onStatus?.('One-time approval for this market type: sign it in your wallet (gasless)…')
      await signers.prepareOwner()
      const handle =
        sync.assetType === AssetType.COLLATERAL
          ? await client.approveErc20({ amount: 'max', spenderAddress: spender, tokenAddress: CONTRACTS.collateralToken })
          : await client.approveErc1155ForAll({
              operatorAddress: spender,
              // V2 positions live in the PositionManager, V1 positions in the CTF contract.
              tokenAddress: sync.assetType === AssetType.CONDITIONAL_V2 ? CONTRACTS.positionManager : CONTRACTS.conditionalTokens,
            })
      await handle.wait()
      onStatus?.('Approved. Placing your order…')
    }
    // Refresh the CLOB's cached balance/allowance before retrying.
    await updateBalanceAllowance(client, sync)
    result = await attempt()
  }
  if (result instanceof Error) throw result
  return result
}

/**
 * Extracts the spender from a CLOB "allowance is not enough -> spender: 0x…" rejection, but only
 * when it is one of Polymarket's own contracts from the SDK; we never approve anything else.
 */
function missingApprovalSpender(message: string): `0x${string}` | null {
  const match = message.match(/allowance is not enough\s*->\s*spender:\s*(0x[0-9a-fA-F]{40})/i)
  if (!match) return null
  const spender = match[1].toLowerCase()
  const known = Object.values(CONTRACTS as Record<string, unknown>).some(
    (addr) => typeof addr === 'string' && addr.toLowerCase() === spender,
  )
  return known ? (match[1] as `0x${string}`) : null
}

/** pUSD the CLOB currently sees as spendable for this account. */
export async function tradingBalance(client: PolyClient): Promise<number> {
  const res = await updateBalanceAllowance(client, { assetType: AssetType.COLLATERAL })
  return Number(res.balance) / 1e6
}

/** Market buy for `amountUsd` pUSD, filling only at `maxPrice` or better. Signed in the browser. */
export async function buy(
  signers: TradeSigners,
  params: { tokenId: string; amountUsd: string; maxPrice: string },
  onStatus?: (text: string) => void,
) {
  const client = signers.trade
  const response = await withBalanceSync(
    signers,
    { assetType: AssetType.COLLATERAL },
    () =>
      client.placeMarketOrder({
        assetId: params.tokenId,
        side: OrderSide.BUY,
        amount: params.amountUsd,
        maxPrice: params.maxPrice,
        builderCode: builderCode(),
      }),
    onStatus,
  )
  return check(response)
}

/** Market sell of `shares`, filling only at `minPrice` or better. Allowed for close-only users. */
export async function sell(
  signers: TradeSigners,
  params: { tokenId: string; shares: string; minPrice: string; version?: ProtocolVersion },
  onStatus?: (text: string) => void,
) {
  const client = signers.trade
  const response = await withBalanceSync(
    signers,
    { assetType: params.version === 'v2' ? AssetType.CONDITIONAL_V2 : AssetType.CONDITIONAL, assetId: params.tokenId },
    () =>
      client.placeMarketOrder({
        assetId: params.tokenId,
        side: OrderSide.SELL,
        shares: params.shares,
        minPrice: params.minPrice,
        builderCode: builderCode(),
      }),
    onStatus,
  )
  return check(response)
}

/** Redeems a resolved position into pUSD (gasless via the relayer). */
export async function redeem(client: PolyClient, conditionId: string) {
  try {
    const handle = await client.redeemPositions({ conditionId })
    return await handle.wait()
  } catch (e) {
    // Older @polymarket/client releases could not always look up closed markets (Polymarket/ts-sdk#405).
    if (e instanceof Error && /No market found/i.test(e.message)) {
      throw new Error(
        "Polymarket's SDK could not find this closed market (a known issue). Your winnings are safe: " +
          'redeem them on polymarket.com by signing in with this same wallet, or try again later.',
      )
    }
    throw e
  }
}
