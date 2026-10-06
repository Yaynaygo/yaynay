import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import REAL from './lifi.fixtures.json'
import {
  ARC_CHAIN_ID,
  afterReplacement,
  checkCalldata,
  retryAfterMs,
  SOURCES,
  approvalNeeded,
  breakdown,
  chainDiamondOk,
  checkQuote,
  findSource,
  findToken,
  interpretStatus,
  needsAllowanceReset,
  parseAmount,
  quoteParams,
  tokenMetaMatches,
  validPending,
  type LifiQuote,
  type QuoteExpectation,
} from './lifi'

const USER = '0xA35ab49388eae377D0757d334C07C3bf4FB99AFc' as const
const OTHER = '0x000000000000000000000000000000000000dEaD'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// Trimmed real LI.FI /quote responses (2026-10-06), calldata untouched: Base USDC 5 via Polymer,
// Base ETH 0.002 (swap + Polymer), Ethereum ETH 0.002 via Relay, Arc EURC 5 → USDC via Kyberswap.
const clone = (q: unknown) => structuredClone(q) as LifiQuote
const baseUsdcQuote = () => clone(REAL.baseUsdc)
const base = findSource(8453)!
const baseUsdc = findToken(8453, BASE_USDC)!
const expectBase = (over: Partial<QuoteExpectation> = {}): QuoteExpectation => ({
  source: base,
  token: baseUsdc,
  amount: 5_000_000n,
  user: USER,
  slippage: 0.005,
  ...over,
})

describe('token allowlist', () => {
  it('lists every source chain once, each with a pinned diamond and at least one token', () => {
    const ids = SOURCES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([1, 8453, 42161, 10, 137, 56, 4217, ARC_CHAIN_ID]))
    for (const s of SOURCES) {
      expect(s.diamond).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(s.tokens.length).toBeGreaterThan(0)
    }
  })

  it('has unique, well-formed addresses per chain and never offers Arc USDC as an input', () => {
    for (const s of SOURCES) {
      const addrs = s.tokens.map((t) => t.address.toLowerCase())
      expect(new Set(addrs).size).toBe(addrs.length)
      for (const t of s.tokens) {
        expect(t.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(t.decimals).toBeGreaterThan(0)
        if (s.id === ARC_CHAIN_ID) expect(t.address.toLowerCase()).not.toBe(ARC_USDC)
      }
    }
  })

  it('finds tokens by address only, case-insensitively', () => {
    expect(findToken(8453, BASE_USDC.toLowerCase())?.symbol).toBe('USDC')
    expect(findToken(8453, '0x0000000000000000000000000000000000000001')).toBeUndefined()
    // Same address on another chain is a different token.
    expect(findToken(42161, BASE_USDC)).toBeUndefined()
  })

  it('pins the verified addresses that matter', () => {
    expect(findToken(4217, '0x20C000000000000000000000b9537d11c60E8b50')?.symbol).toBe('USDC.e')
    expect(findToken(ARC_CHAIN_ID, '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1')?.label).toMatch(/stablecoin FX/)
    expect(findToken(ARC_CHAIN_ID, '0x128cC466B61f542da60c70e3aA11c10e19B84EDB')?.symbol).toBe('WETH')
    expect(findToken(56, '0x55d398326f99059fF775485246999027B3197955')?.decimals).toBe(18)
    expect(findSource(4217)?.diamond).toBe('0x2cAcAE8e22418E65dcf7651c67aEbe6288EB8243')
    expect(findSource(ARC_CHAIN_ID)?.diamond).toBe('0xA4072583658Fae592A3506A42431cb6316a8d40b')
  })

  it('keeps Arc long-tail tokens out', () => {
    const arc = findSource(ARC_CHAIN_ID)!
    expect(arc.tokens.map((t) => t.symbol).sort()).toEqual(['EURC', 'WETH', 'cirBTC'])
    expect(findToken(ARC_CHAIN_ID, '0xeCe5cA8bf9220718E5727754026757512212cb3c')).toBeUndefined() // ARGUS
  })

  it('marks only gas coins as native and prices kinds for slippage', () => {
    for (const s of SOURCES) for (const t of s.tokens) if (t.native) expect(t.kind).toBe('volatile')
    expect(findSource(4217)!.tokens.some((t) => t.native)).toBe(false)
  })

  it('rejects token metadata that disagrees with the allowlist', () => {
    const meta = { address: BASE_USDC, chainId: 8453, symbol: 'USDC', decimals: 6 }
    expect(tokenMetaMatches(baseUsdc, meta, 8453)).toBe(true)
    expect(tokenMetaMatches(baseUsdc, { ...meta, decimals: 18 }, 8453)).toBe(false)
    expect(tokenMetaMatches(baseUsdc, { ...meta, chainId: 1 }, 8453)).toBe(false)
  })

  it('refuses a chain whose advertised diamond differs from the pinned one', () => {
    expect(chainDiamondOk(base, { id: 8453, key: 'bas', name: 'Base', diamondAddress: DIAMOND.toLowerCase() })).toBe(true)
    expect(chainDiamondOk(base, { id: 8453, key: 'bas', name: 'Base', diamondAddress: OTHER })).toBe(false)
  })
})

describe('quote request', () => {
  it('always targets Arc USDC for the connected address, with no integrator fee', () => {
    const p = quoteParams({ source: base, token: baseUsdc, amount: 5_000_000n, user: USER, slippage: 0.005 })
    expect(p).toMatchObject({ fromChain: 8453, toChain: 5042, toToken: ARC_USDC, fromAddress: USER, toAddress: USER, integrator: 'yaynay', fromAmount: '5000000' })
    expect(p).not.toHaveProperty('fee')
  })

  it('parses amounts to the token decimals', () => {
    expect(parseAmount('5', 6)).toBe(5_000_000n)
    expect(parseAmount('0.002', 18)).toBe(parseUnits('0.002', 18))
    expect(parseAmount('1.1234567', 6)).toBeNull()
    expect(parseAmount('0', 6)).toBeNull()
    expect(parseAmount('abc', 6)).toBeNull()
  })
})

describe('checkQuote', () => {
  it('accepts a real quote', () => {
    expect(checkQuote(baseUsdcQuote(), expectBase())).toEqual([])
  })

  it('refuses a quote that does not end as USDC on Arc', () => {
    const q = baseUsdcQuote()
    q.action.toChainId = 137
    expect(checkQuote(q, expectBase()).join(' ')).toMatch(/does not end on Arc/)
    const q2 = baseUsdcQuote()
    q2.action.toToken.address = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
    expect(checkQuote(q2, expectBase()).join(' ')).toMatch(/USDC on Arc/)
  })

  it('refuses another recipient or sender, but ignores address case', () => {
    const q = baseUsdcQuote()
    q.action.toAddress = OTHER
    expect(checkQuote(q, expectBase()).join(' ')).toMatch(/another address/)
    const q2 = baseUsdcQuote()
    q2.action.fromAddress = OTHER
    expect(checkQuote(q2, expectBase()).join(' ')).toMatch(/different sender/)
    const q3 = baseUsdcQuote()
    q3.action.toAddress = USER.toLowerCase()
    expect(checkQuote(q3, expectBase())).toEqual([])
  })

  it("refuses a transaction or approval aimed anywhere but LI.FI's diamond", () => {
    const q = baseUsdcQuote()
    q.transactionRequest!.to = OTHER
    expect(checkQuote(q, expectBase()).join(' ')).toMatch(/not addressed to LI.FI/)
    const q2 = baseUsdcQuote()
    q2.estimate.approvalAddress = OTHER
    expect(checkQuote(q2, expectBase()).join(' ')).toMatch(/approval/)
  })

  it('refuses a transaction for another chain, token or amount', () => {
    const q = baseUsdcQuote()
    q.transactionRequest!.chainId = 1
    expect(checkQuote(q, expectBase()).join(' ')).toMatch(/different chain/)
    const q2 = baseUsdcQuote()
    q2.action.fromToken.address = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'
    expect(checkQuote(q2, expectBase()).join(' ')).toMatch(/different token/)
    expect(checkQuote(baseUsdcQuote(), expectBase({ amount: 6_000_000n })).join(' ')).toMatch(/different amount/)
  })

  it('refuses a gas-coin value on a token transfer, and checks it on a native one', () => {
    const q = baseUsdcQuote()
    q.transactionRequest!.value = '0x1'
    expect(checkQuote(q, expectBase()).join(' ')).toMatch(/gas coin/)

    const eth = findToken(8453, '0x0000000000000000000000000000000000000000')!
    const n = clone(REAL.baseEth)
    const e = { ...expectBase(), token: eth, amount: parseUnits('0.002', 18), slippage: 0.005 }
    expect(checkQuote(n, e)).toEqual([])
    n.transactionRequest!.value = '0x0'
    expect(checkQuote(n, e).join(' ')).toMatch(/gas coin/)
  })

  it('refuses an integrator fee', () => {
    const q = baseUsdcQuote()
    q.estimate.feeCosts![0].feeSplit!.integratorFee = '100'
    expect(checkQuote(q, expectBase()).join(' ')).toMatch(/integrator fee/)
  })

  it('refuses a minimum output below the slippage floor', () => {
    const q = baseUsdcQuote()
    q.estimate.toAmountMin = '4900000' // 2% below the input after fees
    expect(checkQuote(q, expectBase()).join(' ')).toMatch(/minimum/)
    const q2 = baseUsdcQuote()
    q2.estimate.toAmountMin = '5000001' // above toAmount
    expect(checkQuote(q2, expectBase()).join(' ')).toMatch(/invalid minimum/)
  })

  it('refuses more slippage than requested and routes eating a fifth of the amount', () => {
    const q = baseUsdcQuote()
    q.action.slippage = 0.05
    expect(checkQuote(q, expectBase()).join(' ')).toMatch(/more slippage/)
    const q2 = baseUsdcQuote()
    q2.estimate.feeCosts![0].amountUSD = '1.5'
    expect(checkQuote(q2, expectBase()).join(' ')).toMatch(/Fees and gas would take/)
  })

  it('refuses a token that is not on the allowlist', () => {
    const q = baseUsdcQuote()
    const fake = { address: OTHER as `0x${string}`, symbol: 'USDC', decimals: 6, kind: 'stable' as const }
    q.action.fromToken.address = OTHER
    expect(checkQuote(q, expectBase({ token: fake })).join(' ')).toMatch(/supported list/)
  })
})

describe('checkCalldata', () => {
  const user = USER.toLowerCase().slice(2)
  const swapAddr = (data: string, to: string) => data.split(user).join(to.toLowerCase().slice(2))

  it('accepts the real bridge, relay and same-chain swap transactions', () => {
    const eth1 = findToken(1, '0x0000000000000000000000000000000000000000')!
    const eurc = findToken(ARC_CHAIN_ID, '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1')!
    expect(checkQuote(clone(REAL.ethRelay), { ...expectBase(), source: findSource(1)!, token: eth1, amount: parseUnits('0.002', 18), slippage: 0.01 })).toEqual([])
    expect(checkQuote(clone(REAL.arcEurc), { ...expectBase(), source: findSource(ARC_CHAIN_ID)!, token: eurc, amount: 5_000_000n, slippage: 0.01 })).toEqual([])
  })

  it('refuses calldata that pays someone else, even when the quote fields look right', () => {
    const q = baseUsdcQuote()
    q.transactionRequest!.data = swapAddr(q.transactionRequest!.data!, OTHER)
    expect(checkCalldata(q, expectBase())).toEqual(['The transaction does not name your address.'])

    const s = clone(REAL.arcEurc)
    s.transactionRequest!.data = swapAddr(s.transactionRequest!.data!, OTHER)
    const eurc = findToken(ARC_CHAIN_ID, '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1')!
    expect(checkCalldata(s, { ...expectBase(), source: findSource(ARC_CHAIN_ID)!, token: eurc, amount: 5_000_000n, slippage: 0.01 })).not.toEqual([])
  })

  it('refuses a bridge to another chain, a destination call or another bridge', () => {
    const data = baseUsdcQuote().transactionRequest!.data!
    // BridgeData words (after the 4-byte selector and the tuple offset): destinationChainId is word 7, hasDestinationCall word 9.
    const words = data.slice(10).match(/.{64}/g)!
    const off = Number(BigInt(`0x${words[0]}`)) / 32
    const patch = (i: number, v: bigint) => {
      const w = [...words]
      w[off + i] = v.toString(16).padStart(64, '0')
      const q = baseUsdcQuote()
      q.transactionRequest!.data = data.slice(0, 10) + w.join('') + data.slice(10 + w.length * 64)
      return checkCalldata(q, expectBase()).join(' ')
    }
    expect(patch(7, 137n)).toMatch(/does not go to Arc/)
    expect(patch(9, 1n)).toMatch(/extra code on Arc/)
    expect(patch(6, 1n)).toMatch(/minimum/)
    const q = baseUsdcQuote()
    q.tool = 'across'
    expect(checkCalldata(q, expectBase()).join(' ')).toMatch(/different bridge/)
  })

  it('refuses a swap whose on-chain minimum is below the quote, and unknown swap selectors', () => {
    const eurc = findToken(ARC_CHAIN_ID, '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1')!
    const e = { ...expectBase(), source: findSource(ARC_CHAIN_ID)!, token: eurc, amount: 5_000_000n, slippage: 0.01 }
    const q = clone(REAL.arcEurc)
    q.estimate.toAmountMin = (BigInt(q.estimate.toAmountMin) + 1n).toString()
    expect(checkCalldata(q, e).join(' ')).toMatch(/lower than quoted/)
    const u = clone(REAL.arcEurc)
    u.transactionRequest!.data = '0xdeadbeef' + u.transactionRequest!.data!.slice(10)
    expect(checkCalldata(u, e).join(' ')).toMatch(/recognise/)
  })

  it('refuses undecodable bridge data', () => {
    const q = baseUsdcQuote()
    q.transactionRequest!.data = `0x12345678${'0'.repeat(24)}${user}`
    expect(checkCalldata(q, expectBase()).join(' ')).toMatch(/decoded|another address/)
  })
})

describe('afterReplacement', () => {
  const p = { user: USER, txHash: '0x1', fromChainId: 8453, tool: 't', toolName: 'T', symbol: 'USDC', amount: '5', expected: '4.98', startedAt: 1 }
  it('follows a sped-up transaction and drops a cancelled one', () => {
    expect(afterReplacement(p, 'replaced', '0x2')?.txHash).toBe('0x2')
    expect(afterReplacement(p, 'repriced', '0x3')?.txHash).toBe('0x3')
    expect(afterReplacement(p, 'cancelled', '0x4')).toBeNull()
  })
})

describe('retryAfterMs', () => {
  it("reads Retry-After or LI.FI's message", () => {
    expect(retryAfterMs('30', '')).toBe(30_000)
    expect(retryAfterMs(null, 'Rate limit exceeded, retry in 1 hour')).toBe(3_600_000)
    expect(retryAfterMs(null, 'retry in 5 minutes')).toBe(300_000)
    expect(retryAfterMs(null, 'Too many requests')).toBeUndefined()
  })
})

describe('breakdown', () => {
  it('itemises fees and gas and values stables at face value', () => {
    const b = breakdown(baseUsdcQuote(), baseUsdc)
    expect(b.inUsd).toBe(5)
    expect(b.toAmount).toBeCloseTo(4.9875)
    expect(b.fees).toEqual([{ name: 'LI.FI fee', usd: 0.0125, included: true }])
    expect(b.gas).toEqual({ usd: 0.0041, symbol: 'ETH' })
    expect(b.costUsd).toBeCloseTo(0.0166)
    expect(b.route).toEqual(['Polymer (Standard)'])
    expect(b.seconds).toBe(1080)
  })
})

describe('approvals', () => {
  it('approves exactly the amount, only when needed, never for gas coins', () => {
    const eth = findToken(1, '0x0000000000000000000000000000000000000000')!
    expect(approvalNeeded(baseUsdc, 0n, 5n)).toBe(5n)
    expect(approvalNeeded(baseUsdc, 4n, 5n)).toBe(5n)
    expect(approvalNeeded(baseUsdc, 5n, 5n)).toBeNull()
    expect(approvalNeeded(eth, 0n, 5n)).toBeNull()
  })

  it('resets a non-zero allowance first for Ethereum USDT only', () => {
    const usdt = findToken(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7')!
    expect(needsAllowanceReset(1, usdt, 1n)).toBe(true)
    expect(needsAllowanceReset(1, usdt, 0n)).toBe(false)
    expect(needsAllowanceReset(8453, baseUsdc, 1n)).toBe(false)
  })
})

describe('interpretStatus', () => {
  const tx = '0xabc'
  it('waits while unknown or pending, and ignores answers about another transfer', () => {
    expect(interpretStatus(null, tx).phase).toBe('pending')
    expect(interpretStatus({ status: 'PENDING' }, tx).phase).toBe('pending')
    expect(interpretStatus({ status: 'DONE', sending: { txHash: '0xother' } }, tx).phase).toBe('pending')
  })

  it('reports arrival with the USDC amount on Arc', () => {
    const s = interpretStatus(
      {
        status: 'DONE',
        substatus: 'COMPLETED',
        sending: { txHash: '0xABC' },
        receiving: { chainId: 5042, txHash: '0xdef', amount: '4987500', token: { address: ARC_USDC, chainId: 5042, symbol: 'USDC', decimals: 6 } },
      },
      tx,
    )
    expect(s).toEqual({ phase: 'done', received: 4.9875, arcTx: '0xdef' })
  })

  it('flags refunds, partial fills and failures', () => {
    expect(interpretStatus({ status: 'DONE', substatus: 'REFUNDED' }, tx).phase).toBe('refunded')
    expect(interpretStatus({ status: 'DONE', substatus: 'PARTIAL', receiving: { chainId: 5042 } }, tx).phase).toBe('partial')
    expect(interpretStatus({ status: 'FAILED' }, tx).phase).toBe('failed')
  })
})

describe('validPending', () => {
  const p = { user: USER, txHash: '0x1', fromChainId: 8453, tool: 't', toolName: 'T', symbol: 'USDC', amount: '5', expected: '4.98', startedAt: 1_000 }
  it('belongs to one wallet and expires after a day', () => {
    expect(validPending(p, USER.toLowerCase(), 2_000)).toBe(p)
    expect(validPending(p, OTHER, 2_000)).toBeNull()
    expect(validPending(p, USER, 1_000 + 25 * 3600_000)).toBeNull()
    expect(validPending(null, USER)).toBeNull()
  })
})

import { gasWithBuffer } from './lifi'

describe('gasWithBuffer', () => {
  it('pads our estimate by 30% and fixes the Tempo shortfall', () => {
    // Real Tempo case: LI.FI quoted 596,700; the transfer needed 667,618.
    expect(gasWithBuffer(667_618n, '0x91adc')).toBe(867_903n)
  })
  it("never goes below LI.FI's figure", () => {
    expect(gasWithBuffer(100_000n, '500000')).toBe(500_000n)
  })
  it("adds 50% to LI.FI's figure when we have no estimate", () => {
    expect(gasWithBuffer(null, '0x91adc')).toBe(895_050n)
    expect(gasWithBuffer(null, undefined)).toBeUndefined()
    expect(gasWithBuffer(null, 'nonsense')).toBeUndefined()
  })
})

import { matchArrival } from './lifi'

describe('matchArrival', () => {
  // Real Tempo → Arc case: LI.FI's status API couldn't find the tx; 3.986591 USDC arrived from a relayer.
  const t = (usdc: number, ts: number, txHash = '0xa') => ({ value: BigInt(Math.round(usdc * 1e6)), timestamp: ts, txHash })
  it('finds the transfer close to the expected amount after the send', () => {
    expect(matchArrival([t(1.5, 1100), t(3.986591, 1200, '0xarc')], { expected: 3.99, sinceSec: 1000 })).toEqual({ amount: 3.986591, txHash: '0xarc' })
  })
  it('ignores transfers before the send or far from the amount', () => {
    expect(matchArrival([t(3.99, 800), t(9, 1200), t(1, 1300)], { expected: 3.99, sinceSec: 1000 })).toBeNull()
  })
})
