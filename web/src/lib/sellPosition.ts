import { fetchBookTop, roundToTick, type Position } from './markets'
import type { PolyClient } from './polyAccount'
import { ensureApiSession } from './apiSession'

/** How far under the best bid a market sell may fill; protects against a book that moves while signing. */
export const SELL_SLIPPAGE = 0.05

/** Whole position, floored to 2 decimals without float artifacts (5.29 must not become 5.28). */
export const sellableShares = (size: number) => Math.floor(Math.round(size * 1e6) / 1e4) / 100

export type SellQuote = { bestBid: number; minPrice: string; shares: number; estimate: number }

/** What selling the whole position would fetch right now, or null when nobody is bidding. */
export async function quoteSell(p: Position): Promise<SellQuote | null> {
  const book = await fetchBookTop(p.asset)
  if (book.bestBid === null) return null
  const shares = sellableShares(p.size)
  const minPrice = roundToTick(Math.max(book.tickSize, book.bestBid - SELL_SLIPPAGE), book.tickSize)
  return { bestBid: book.bestBid, minPrice, shares, estimate: shares * book.bestBid }
}

/**
 * Sells a whole position at market (fill-and-kill, floored at `minPrice`). The same flow the portfolio
 * uses: a 1-click session key signs without prompts when present, otherwise the owner's wallet does.
 */
export async function sellPosition(
  p: Position,
  q: SellQuote,
  ctx: { client: PolyClient; tradeClient: PolyClient | null; onPolygon: () => Promise<void>; onStatus: (text: string) => void },
): Promise<{ sold: number; received: number }> {
  if (ctx.tradeClient) {
    await ensureApiSession()
    ctx.onStatus(`Selling (best bid ${q.bestBid}, min ${q.minPrice})…`)
  } else {
    await ctx.onPolygon()
    ctx.onStatus(`Sign the sell order in your wallet (best bid ${q.bestBid}, min ${q.minPrice})…`)
  }
  const [{ sell }, { marketVersion }] = await Promise.all([import('./trade'), import('./protocol')])
  // The Data API doesn't say which protocol a position is on; V2 positions sell with a different asset type.
  const version = await marketVersion(p.conditionId)
  const signers = { trade: ctx.tradeClient ?? ctx.client, owner: ctx.client, prepareOwner: ctx.onPolygon }
  const res = await sell(signers, { tokenId: p.asset, shares: String(q.shares), minPrice: q.minPrice, version }, ctx.onStatus)
  return { sold: Number(res.makingAmount || q.shares), received: Number(res.takingAmount) || 0 }
}
