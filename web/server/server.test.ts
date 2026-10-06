import { describe, expect, it } from 'vitest'
import { buildHmacSignature } from '@polymarket/client'
import { builderSignature } from './hmac.ts'
import { parseSignRequest, SignError } from './builderSign.ts'
import { createSessionCookie, hasValidSession, SESSION_COOKIE } from './session.ts'
import { countAndCheck, LIMITS, type D1Like } from './limits.ts'
import { originError } from './guard.ts'

const SECRET = 'c2VjcmV0LWZvci10ZXN0cy1vbmx5LTEyMzQ1Njc4OTA='

describe('builderSignature', () => {
  it.each([
    ['GET', '/nonce?address=0xabc&type=WALLET', undefined],
    ['POST', '/submit', '{"type":"WALLET","from":"0xabc"}'],
    ['DELETE', '/order', ''],
  ])('matches the SDK for %s %s', async (method, path, body) => {
    const ts = 1791240000
    expect(await builderSignature(SECRET, ts, method, path, body)).toBe(
      await buildHmacSignature(SECRET, ts, method, path, body),
    )
  })
})

describe('parseSignRequest', () => {
  const status = (input: unknown) => {
    try {
      parseSignRequest(input)
      return 'ok'
    } catch (e) {
      return e instanceof SignError ? e.status : 'other'
    }
  }

  it('allows reads and the user trading writes', () => {
    expect(status({ method: 'GET', path: '/auth/derive-api-key' })).toBe('ok')
    expect(status({ method: 'get', path: '/balance-allowance/update?asset_type=COLLATERAL' })).toBe('ok')
    expect(status({ method: 'POST', path: '/order', body: '{}' })).toBe('ok')
    expect(status({ method: 'DELETE', path: '/cancel-all' })).toBe('ok')
    expect(status({ method: 'POST', path: '/submit', body: '{"type":"WALLET-CREATE","from":"0xAbC"}' })).toBe('ok')
  })

  it('refuses builder-account routes and unknown writes', () => {
    expect(status({ method: 'GET', path: '/auth/builder-api-key' })).toBe(403)
    expect(status({ method: 'DELETE', path: '/auth/builder-api-key' })).toBe(403)
    expect(status({ method: 'GET', path: '/builder/trades' })).toBe(403)
    expect(status({ method: 'GET', path: '/v1/builder/rfq/requests' })).toBe(403)
    expect(status({ method: 'POST', path: '/something' })).toBe(403)
    expect(status({ method: 'PUT', path: '/order' })).toBe(403)
  })

  it('signs 1-click trading key authorizations as relayer transactions', () => {
    const req = parseSignRequest({
      method: 'POST',
      path: '/v1/session-signers/authorizations',
      body: '{"walletAddress":"0xWaLLet","sessionSignerAddress":"0x1"}',
    })
    expect(req.isRelayerTx).toBe(true)
    expect(req.relayerFrom).toBe('0xwallet')
    expect(parseSignRequest({ method: 'POST', path: '/order', body: '{}' }).isRelayerTx).toBe(false)
  })

  it('only relays Deposit Wallet transactions', () => {
    expect(status({ method: 'POST', path: '/submit', body: '{"type":"SAFE"}' })).toBe(403)
    expect(status({ method: 'POST', path: '/submit', body: '{"type":"PROXY"}' })).toBe(403)
    expect(status({ method: 'POST', path: '/submit', body: 'not json' })).toBe(400)
    expect(parseSignRequest({ method: 'POST', path: '/submit', body: '{"type":"WALLET","from":"0xAbC"}' }).relayerFrom).toBe(
      '0xabc',
    )
  })

  it('rejects malformed input', () => {
    expect(status(null)).toBe(400)
    expect(status({ method: 'GET', path: 'nonce' })).toBe(400)
    expect(status({ method: 'POST', path: '/order', body: 42 })).toBe(400)
  })
})

describe('session cookie', () => {
  it('accepts its own cookie and rejects tampering or expiry', async () => {
    const { cookie } = await createSessionCookie('k1', Date.UTC(2026, 9, 6))
    const header = cookie.split(';')[0]
    expect(header.startsWith(`${SESSION_COOKIE}=`)).toBe(true)
    expect(await hasValidSession(header, 'k1', Date.UTC(2026, 9, 6, 1))).toBe(true)
    expect(await hasValidSession(header, 'k2', Date.UTC(2026, 9, 6, 1))).toBe(false)
    expect(await hasValidSession(header, 'k1', Date.UTC(2026, 9, 7, 1))).toBe(false)
    expect(await hasValidSession(header.replace(/.$/, '0'), 'k1', Date.UTC(2026, 9, 6, 1))).toBe(header.endsWith('0'))
    expect(await hasValidSession(null, 'k1')).toBe(false)
  })
})

describe('originError', () => {
  const req = (headers: Record<string, string>) => new Request('https://yaynay.pages.dev/api/builder/sign', { method: 'POST', headers })

  it('requires our own origin', () => {
    expect(originError(req({ Origin: 'https://yaynay.pages.dev', 'Sec-Fetch-Site': 'same-origin' }))).toBeNull()
    expect(originError(req({}))).toBe('origin not allowed')
    expect(originError(req({ Origin: 'https://evil.example' }))).toBe('origin not allowed')
    expect(originError(req({ Origin: 'https://arcodds.xyz' }), 'https://arcodds.xyz')).toBeNull()
    expect(originError(req({ Origin: 'https://yaynay.pages.dev', 'Sec-Fetch-Site': 'cross-site' }))).toBe(
      'cross-site request refused',
    )
  })
})

describe('countAndCheck', () => {
  function memoryDb(): D1Like {
    const rows = new Map<string, number>()
    return {
      prepare: () => ({ bind: (k: unknown) => k }),
      batch: async (keys) =>
        keys.map((k) => {
          const n = (rows.get(k as string) ?? 0) + 1
          rows.set(k as string, n)
          return { results: [{ n }] }
        }),
    }
  }

  it('never stores a raw IP address', async () => {
    const seen: string[] = []
    const db: D1Like = {
      prepare: () => ({ bind: (k: unknown) => (seen.push(String(k)), k) }),
      batch: async (keys) => keys.map(() => ({ results: [{ n: 1 }] })),
    }
    await countAndCheck(db, { ip: '203.0.113.7', isRelayer: true, salt: 'secret' })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some((k) => k.includes('203.0.113.7'))).toBe(false)
  })

  it('caps relayer transactions per wallet and globally', async () => {
    const db = memoryDb()
    const now = new Date('2026-10-06T12:00:00Z')
    for (let i = 0; i < LIMITS.relayerPerWallet; i++) {
      expect((await countAndCheck(db, { ip: `1.1.1.${i}`, isRelayer: true, wallet: '0xa', salt: 's' }, now)).ok).toBe(true)
    }
    expect((await countAndCheck(db, { ip: '2.2.2.2', isRelayer: true, wallet: '0xa', salt: 's' }, now)).ok).toBe(false)
    // A new day starts fresh.
    expect((await countAndCheck(db, { ip: '2.2.2.2', isRelayer: true, wallet: '0xa', salt: 's' }, new Date('2026-10-07T00:00:01Z'))).ok).toBe(true)
  })
})
