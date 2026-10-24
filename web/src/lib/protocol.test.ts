import { afterEach, describe, expect, it } from 'vitest'
import { clearVersionCache, marketVersion, tradingIds, versionOf } from './protocol'

afterEach(clearVersionCache)

describe('tradingIds', () => {
  it('uses CTF token IDs for V1 markets', () => {
    expect(tradingIds({ version: 'v1', clobTokenIds: '["11","22"]', positionIds: ['1', '2'] })).toEqual({ version: 'v1', ids: ['11', '22'] })
  })
  it('uses position IDs for V2 markets', () => {
    expect(tradingIds({ version: 'v2', clobTokenIds: '["11","22"]', positionIds: ['1', '2'] })).toEqual({ version: 'v2', ids: ['1', '2'] })
    expect(tradingIds({ version: 'V2', positionIds: '["3","4"]' }).ids).toEqual(['3', '4'])
  })
  it('treats a missing version as V1', () => {
    expect(versionOf({})).toBe('v1')
    expect(tradingIds({ clobTokenIds: '["5","6"]' }).ids).toEqual(['5', '6'])
  })
})

describe('marketVersion', () => {
  const json = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
  it('reads the version from Gamma and caches it', async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response(JSON.stringify([{ version: 'v2' }]))
    }) as unknown as typeof fetch
    expect(await marketVersion('0xAB', fetcher)).toBe('v2')
    expect(await marketVersion('0xab', fetcher)).toBe('v2')
    expect(calls).toBe(1)
  })
  it('falls back to V1 for unknown markets and failures', async () => {
    expect(await marketVersion('0x1', json([]))).toBe('v1')
    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await marketVersion('0x2', failing)).toBe('v1')
  })
})
