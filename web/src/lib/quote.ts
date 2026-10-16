import { CLOB_API } from '../config'

export type Level = { price: number; size: number }

/** Ask side of the CLOB order book, cheapest first (public endpoint). */
export async function fetchAsks(tokenId: string): Promise<Level[]> {
  const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`)
  if (!res.ok) throw new Error(`Order book unavailable: ${res.status}`)
  const book = (await res.json()) as { asks?: { price: string; size: string }[] }
  return (book.asks ?? []).map((a) => ({ price: Number(a.price), size: Number(a.size) })).sort((a, b) => a.price - b.price)
}

export type FeeParams = { rate: number; exponent: number }

/**
 * Taker fee parameters for a market. Polymarket charges takers
 * fee = shares × rate × (p × (1 − p))^exponent; makers pay nothing.
 * Source: https://docs.polymarket.com/trading/fees.md
 */
export async function fetchFeeParams(conditionId: string): Promise<FeeParams> {
  const res = await fetch(`${CLOB_API}/clob-markets/${conditionId}`)
  if (!res.ok) throw new Error(`Market info unavailable: ${res.status}`)
  const info = (await res.json()) as { fd?: { r?: number; e?: number } }
  return { rate: info.fd?.r ?? 0, exponent: info.fd?.e ?? 1 }
}

export type BuyQuote = {
  shares: number
  avgPrice: number
  worstPrice: number
  fee: number
  /** USD actually matched; less than requested when the book is too thin. */
  filledUsd: number
}

/** Walks the asks to estimate what a market buy of `amountUsd` would get, including the taker fee. */
export function quoteBuy(asks: Level[], amountUsd: number, fee: FeeParams): BuyQuote | null {
  let remaining = amountUsd
  let shares = 0
  let feeUsd = 0
  let worstPrice = 0
  for (const level of asks) {
    if (remaining <= 1e-9) break
    const take = Math.min(remaining / level.price, level.size)
    shares += take
    remaining -= take * level.price
    feeUsd += take * fee.rate * Math.pow(level.price * (1 - level.price), fee.exponent)
    worstPrice = level.price
  }
  if (shares === 0) return null
  const filledUsd = amountUsd - remaining
  return { shares, avgPrice: filledUsd / shares, worstPrice, fee: feeUsd, filledUsd }
}

/**
 * The largest spend, rounded down to the cent, whose cost including Polymarket's fee fits in `balance`.
 * The fee grows with the spend, so this searches instead of subtracting a fixed amount.
 */
export function maxAffordableSpend(asks: Level[], balance: number, fee: FeeParams): number {
  const cost = (spend: number) => {
    const q = quoteBuy(asks, spend, fee)
    return q ? q.filledUsd + q.fee : 0
  }
  let lo = 0
  let hi = Math.floor(balance * 100)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (cost(mid / 100) <= balance + 1e-9) lo = mid
    else hi = mid - 1
  }
  return lo / 100
}
