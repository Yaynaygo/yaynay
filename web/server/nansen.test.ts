import { beforeAll, describe, expect, it, vi } from 'vitest'
import { countNansenLookup, handleNansen, resolveEndpoint, type CacheLike, type NansenEnv } from './nansen.ts'
import { createSessionCookie } from './session.ts'
import type { D1Like } from './limits.ts'

const ORIGIN = 'https://yaynay.app'
const ADDR = '0x' + 'ab'.repeat(20)

const SECRET = 'session-secret-for-tests'
let COOKIE = ''

const req = (body: unknown, origin: string | null = ORIGIN, opts: { cookie?: string; ip?: string } = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': opts.ip ?? '203.0.113.9' }
  if (origin) headers.Origin = origin
  const cookie = opts.cookie ?? COOKIE
  if (cookie) headers.Cookie = cookie
  return new Request(`${ORIGIN}/api/nansen/prediction-market/address-summary`, { method: 'POST', headers, body: JSON.stringify(body) })
}

/** Map-backed D1 stand-in that understands the upsert-and-return used by the counters. */
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

const envWith = (over: Partial<NansenEnv> = {}): NansenEnv => ({
  NANSEN_API_KEY: 'k',
  NANSEN_ENABLED: '1',
  SESSION_SECRET: SECRET,
  DB: memoryDb(),
  ...over,
})

const ok = () => vi.fn(async () => new Response('{"data":[{"win_rate":0.6}]}', { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>

const memCache = (): CacheLike & { store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    store,
    match: async (k) => (store.has(String(k)) ? new Response(store.get(String(k))) : undefined),
    put: async (k, r) => void store.set(String(k), await r.text()),
  }
}

const PATH = ['prediction-market', 'address-summary']

describe('nansen proxy', () => {
  beforeAll(async () => {
    COOKIE = (await createSessionCookie(SECRET)).cookie.split(';')[0]
  })

  it('allowlists only known endpoints', () => {
    expect(resolveEndpoint(PATH)).not.toBeNull()
    expect(resolveEndpoint('prediction-market/address-summary')).not.toBeNull()
    expect(resolveEndpoint(['smart-money', 'netflow'])).toBeNull()
    expect(resolveEndpoint(['constructor'])).toBeNull()
  })

  it('refuses foreign origins before anything else', async () => {
    const res = await handleNansen(req({ address: ADDR }, 'https://evil.example'), envWith(), PATH)
    expect(res.status).toBe(403)
  })

  it.each([
    ['no key', { NANSEN_API_KEY: undefined }],
    ['key but not enabled', { NANSEN_ENABLED: undefined }],
    ['enabled with a value other than 1', { NANSEN_ENABLED: 'true' }],
    ['no session secret', { SESSION_SECRET: undefined }],
    ['no D1 and no explicit opt-out', { DB: undefined }],
  ])('returns 404 not configured with %s', async (_, over) => {
    const upstream = ok()
    const res = await handleNansen(req({ address: ADDR }), envWith(over), PATH, { fetch: upstream })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not configured' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects bad bodies and unknown paths', async () => {
    expect((await handleNansen(req({ address: 'nope' }), envWith(), PATH)).status).toBe(400)
    expect((await handleNansen(req({ address: ADDR }), envWith(), ['x'])).status).toBe(404)
  })

  it('requires a valid session cookie', async () => {
    const upstream = ok()
    const none = await handleNansen(req({ address: ADDR }, ORIGIN, { cookie: 'other=1' }), envWith(), PATH, { fetch: upstream })
    expect(none.status).toBe(401)
    const forged = await handleNansen(req({ address: ADDR }, ORIGIN, { cookie: 'yaynay_s=9999999999.abc.def' }), envWith(), PATH, { fetch: upstream })
    expect(forged.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('injects the key server-side, rebuilds the body and caches the result', async () => {
    const upstream = ok()
    const cache = memCache()
    const env = envWith({ NANSEN_API_KEY: 'secret' })
    const first = await handleNansen(req({ address: ADDR.toUpperCase().replace('0X', '0x'), extra: 1 }), env, PATH, { fetch: upstream, cache })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ data: [{ win_rate: 0.6 }] })
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.nansen.ai/api/v1/prediction-market/address-summary')
    expect((init.headers as Record<string, string>).apikey).toBe('secret')
    expect(init.body).toBe(JSON.stringify({ address: ADDR }))

    const second = await handleNansen(req({ address: ADDR }), env, PATH, { fetch: upstream, cache })
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('caps paid lookups per IP and returns a friendly 429', async () => {
    const upstream = ok()
    const env = envWith({ NANSEN_PER_IP_DAILY: '3' })
    const addr = (i: number) => '0x' + i.toString(16).padStart(40, '0')
    for (let i = 0; i < 3; i++) expect((await handleNansen(req({ address: addr(i) }), env, PATH, { fetch: upstream })).status).toBe(200)
    const capped = await handleNansen(req({ address: addr(9) }), env, PATH, { fetch: upstream })
    expect(capped.status).toBe(429)
    expect(((await capped.json()) as { error: string }).error).toMatch(/your network/)
    expect(upstream).toHaveBeenCalledTimes(3)
    // another network still gets through
    expect((await handleNansen(req({ address: addr(9) }, ORIGIN, { ip: '198.51.100.1' }), env, PATH, { fetch: upstream })).status).toBe(200)
  })

  it('caps paid lookups globally', async () => {
    const upstream = ok()
    const env = envWith({ NANSEN_GLOBAL_DAILY: '2' })
    const addr = (i: number) => '0x' + i.toString(16).padStart(40, '0')
    for (let i = 0; i < 2; i++) {
      expect((await handleNansen(req({ address: addr(i) }, ORIGIN, { ip: `10.0.0.${i}` }), env, PATH, { fetch: upstream })).status).toBe(200)
    }
    const capped = await handleNansen(req({ address: addr(5) }, ORIGIN, { ip: '10.0.0.99' }), env, PATH, { fetch: upstream })
    expect(capped.status).toBe(429)
    expect(((await capped.json()) as { error: string }).error).toMatch(/daily limit/)
  })

  it('does not count cache hits against the caps', async () => {
    const upstream = ok()
    const env = envWith({ NANSEN_PER_IP_DAILY: '1' })
    const cache = memCache()
    for (let i = 0; i < 4; i++) expect((await handleNansen(req({ address: ADDR }), env, PATH, { fetch: upstream, cache })).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the counter breaks', async () => {
    const upstream = ok()
    const db: D1Like = { prepare: () => ({ bind: () => ({}) }), batch: async () => Promise.reject(new Error('D1 down')) }
    const res = await handleNansen(req({ address: ADDR }), envWith({ DB: db }), PATH, { fetch: upstream })
    expect(res.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('hides upstream error bodies and does not cache them', async () => {
    const upstream = vi.fn(async () => new Response('{"message":"insufficient credits"}', { status: 402 }))
    const cache = memCache()
    const res = await handleNansen(req({ address: ADDR }), envWith(), PATH, { fetch: upstream as unknown as typeof fetch, cache })
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('credits')
    expect(cache.store.size).toBe(0)
  })
})

describe('countNansenLookup', () => {
  it('stores only hashed IPs under day-prefixed keys and resets the next day', async () => {
    const db = memoryDb()
    const p = { ip: '203.0.113.7', salt: 's', perIp: 1, global: 10 }
    expect((await countNansenLookup(db, p, new Date('2026-10-06T12:00:00Z'))).ok).toBe(true)
    expect((await countNansenLookup(db, p, new Date('2026-10-06T13:00:00Z'))).ok).toBe(false)
    expect((await countNansenLookup(db, p, new Date('2026-10-07T00:00:01Z'))).ok).toBe(true)
    const keys = [...db.rows.keys()]
    expect(keys.every((k) => /^2026-10-0[67]:n:/.test(k))).toBe(true)
    expect(keys.some((k) => k.includes('203.0.113.7'))).toBe(false)
  })
})
