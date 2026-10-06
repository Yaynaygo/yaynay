import { beforeAll, describe, expect, it, vi } from 'vitest'
import { handleLifiQuote, quoteQuery, type CacheLike, type LifiEnv } from './lifiProxy.ts'
import { createSessionCookie } from './session.ts'
import type { D1Like } from './limits.ts'

const ORIGIN = 'https://yaynay.app'
const USER = '0x' + 'ab'.repeat(20)
const SECRET = 'session-secret-for-tests'
let COOKIE = ''

const PARAMS = {
  fromChain: 8453,
  toChain: 5042,
  fromToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  toToken: '0x3600000000000000000000000000000000000000',
  fromAmount: '5000000',
  fromAddress: USER,
  toAddress: USER,
  slippage: 0.005,
  integrator: 'yaynay',
}

const req = (body: unknown, opts: { origin?: string | null; cookie?: string; ip?: string; method?: string } = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': opts.ip ?? '203.0.113.9' }
  const origin = opts.origin === undefined ? ORIGIN : opts.origin
  if (origin) headers.Origin = origin
  const cookie = opts.cookie ?? COOKIE
  if (cookie) headers.Cookie = cookie
  const method = opts.method ?? 'POST'
  return new Request(`${ORIGIN}/api/lifi/quote`, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined })
}

function memoryDb(): D1Like & { rows: Map<string, number> } {
  const rows = new Map<string, number>()
  return {
    rows,
    prepare: (sql: string) => ({ bind: (...v: unknown[]) => ({ sql, v }) }),
    batch: async (stmts: unknown[]) =>
      (stmts as { sql: string; v: unknown[] }[]).map(({ sql, v }) => {
        if (!sql.startsWith('INSERT')) return {}
        const k = String(v[0])
        rows.set(k, (rows.get(k) ?? 0) + 1)
        return { results: [{ n: rows.get(k) }] }
      }),
  }
}

const envWith = (over: Partial<LifiEnv> = {}): LifiEnv => ({ LIFI_API_KEY: 'key-1', SESSION_SECRET: SECRET, DB: memoryDb(), ...over })

const upstreamOk = () =>
  vi.fn(async () => new Response('{"id":"q1","tool":"polymer"}', { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>

const memCache = (): CacheLike => {
  const store = new Map<string, string>()
  return {
    match: async (k) => (store.has(String(k)) ? new Response(store.get(String(k))) : undefined),
    put: async (k, r) => void store.set(String(k), await r.text()),
  }
}

beforeAll(async () => {
  COOKIE = (await createSessionCookie(SECRET)).cookie.split(';')[0]
})

describe('quoteQuery', () => {
  const qs = (over: Record<string, unknown> = {}) =>
    new URLSearchParams(Object.entries({ ...PARAMS, ...over }).map(([k, v]): [string, string] => [k, String(v)]))

  it('rebuilds a valid top-up quote request', () => {
    const q = quoteQuery(qs())
    expect(q?.get('toChain')).toBe('5042')
    expect(q?.get('toAddress')).toBe(USER)
    expect(q?.get('integrator')).toBe('yaynay')
  })
  it('refuses another destination chain, token or recipient', () => {
    expect(quoteQuery(qs({ toChain: 137 }))).toBeNull()
    expect(quoteQuery(qs({ toToken: '0x' + '11'.repeat(20) }))).toBeNull()
    expect(quoteQuery(qs({ toAddress: '0x' + 'cd'.repeat(20) }))).toBeNull()
  })
  it('refuses unknown chains, extra params and odd amounts', () => {
    expect(quoteQuery(qs({ fromChain: 250 }))).toBeNull()
    expect(quoteQuery(qs({ fee: '0.01' }))).toBeNull()
    expect(quoteQuery(qs({ fromAmount: '-5' }))).toBeNull()
    expect(quoteQuery(qs({ fromAmount: '0' }))).toBeNull()
    expect(quoteQuery(qs({ slippage: 0.5 }))).toBeNull()
    expect(quoteQuery(qs({ integrator: 'someone' }))).toBeNull()
  })
})

describe('LI.FI quote proxy', () => {
  it('forwards with our key and caches the answer', async () => {
    const fetch = upstreamOk()
    const cache = memCache()
    const env = envWith()
    const first = await handleLifiQuote(req(PARAMS), env, { fetch, cache })
    expect(first.status).toBe(200)
    expect(first.headers.get('X-Cache')).toBe('MISS')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('toChain=5042')
    expect((init.headers as Record<string, string>)['x-lifi-api-key']).toBe('key-1')
    const second = await handleLifiQuote(req(PARAMS), env, { fetch, cache })
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('is off without a key, a session secret, or limits', async () => {
    for (const env of [envWith({ LIFI_API_KEY: undefined }), envWith({ SESSION_SECRET: undefined }), envWith({ DB: undefined })]) {
      const fetch = upstreamOk()
      expect((await handleLifiQuote(req(PARAMS), env, { fetch })).status).toBe(404)
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it('refuses foreign origins, GET, bad bodies and missing sessions', async () => {
    const fetch = upstreamOk()
    expect((await handleLifiQuote(req(PARAMS, { origin: 'https://evil.example' }), envWith(), { fetch })).status).toBe(403)
    expect((await handleLifiQuote(req(PARAMS, { method: 'GET' }), envWith(), { fetch })).status).toBe(405)
    expect((await handleLifiQuote(req({ ...PARAMS, toChain: 1 }), envWith(), { fetch })).status).toBe(400)
    expect((await handleLifiQuote(req(['x']), envWith(), { fetch })).status).toBe(400)
    expect((await handleLifiQuote(req(PARAMS, { cookie: 'yaynay_s=forged' }), envWith(), { fetch })).status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('caps quotes per IP and globally', async () => {
    // Refused attempts still count toward the global total (same as the other daily counters).
    const env = envWith({ LIFI_PER_IP_DAILY: '2', LIFI_GLOBAL_DAILY: '4' })
    const fetch = upstreamOk()
    const amount = (n: number) => ({ ...PARAMS, fromAmount: String(5_000_000 + n) })
    expect((await handleLifiQuote(req(amount(1)), env, { fetch })).status).toBe(200)
    expect((await handleLifiQuote(req(amount(2)), env, { fetch })).status).toBe(200)
    expect((await handleLifiQuote(req(amount(3)), env, { fetch })).status).toBe(429)
    expect((await handleLifiQuote(req(amount(4), { ip: '198.51.100.7' }), env, { fetch })).status).toBe(200)
    expect((await handleLifiQuote(req(amount(5), { ip: '192.0.2.1' }), env, { fetch })).status).toBe(429)
    const keys = [...(env.DB as ReturnType<typeof memoryDb>).rows.keys()].join(' ')
    expect(keys).not.toContain('203.0.113.9')
  })

  it("passes LI.FI's message but not its 404, so the client can tell 'no route' from 'not configured'", async () => {
    const upstream = vi.fn(async () => new Response('{"message":"No available quotes for the requested transfer"}', { status: 404 }))
    const res = await handleLifiQuote(req(PARAMS), envWith(), { fetch: upstream as unknown as typeof fetch })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toMatch(/No available quotes/)
  })
})
