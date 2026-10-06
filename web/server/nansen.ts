// Proxy for the few Nansen Prediction Market endpoints the app uses. The API key stays on the
// server; the browser can only reach allowlisted endpoints with request bodies we rebuild ourselves.
// Every paid upstream call needs: NANSEN_ENABLED=1, a valid session cookie, and room under the daily
// per-IP and global caps (counted in the same D1 `hits` table as server/limits.ts).
import { json, originError } from './guard.ts'
import type { D1Like } from './limits.ts'
import { hasValidSession } from './session.ts'

export type NansenEnv = {
  NANSEN_API_KEY?: string
  /** Must be "1": the key alone does not switch the proxy on. */
  NANSEN_ENABLED?: string
  /** Paid lookups per IP per UTC day (default 60). */
  NANSEN_PER_IP_DAILY?: string
  /** Paid lookups per UTC day across everyone (default 2000). */
  NANSEN_GLOBAL_DAILY?: string
  SESSION_SECRET?: string
  ALLOWED_ORIGINS?: string
  DB?: D1Like
  /** Set to "1" only for previews without D1. */
  ALLOW_NO_LIMITS?: string
}

export const NANSEN_DEFAULT_LIMITS = { perIp: 60, global: 2000 }

export const NANSEN_API = 'https://api.nansen.ai/api/v1'
export const NANSEN_CACHE_SECONDS = 300

/** Minimal Cache API surface, so tests can pass a Map-backed stand-in. */
export type CacheLike = {
  match(key: Request | string): Promise<Response | undefined>
  put(key: Request | string, res: Response): Promise<void>
}

type Endpoint = { upstream: string; body: (input: unknown) => Record<string, unknown> | null }

const address = (input: unknown) => {
  const a = (input as { address?: unknown } | null)?.address
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null
}

// Allowlist: path under /api/nansen/ -> upstream path and a validator that rebuilds the body.
const ENDPOINTS: Record<string, Endpoint> = {
  'prediction-market/address-summary': {
    upstream: '/prediction-market/address-summary',
    body: (input) => {
      const a = address(input)
      return a ? { address: a } : null
    },
  },
}

export function resolveEndpoint(path: string[] | string | undefined): Endpoint | null {
  const key = (Array.isArray(path) ? path.join('/') : (path ?? '')).replace(/^\/+|\/+$/g, '')
  return Object.hasOwn(ENDPOINTS, key) ? ENDPOINTS[key] : null
}

const HITS_SCHEMA = 'CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID'
const HIT_SQL = 'INSERT INTO hits (k, n) VALUES (?1, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n'

/** Same salted, truncated SHA-256 as server/limits.ts: the database never holds a raw IP. */
async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`))
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
}

const limitFrom = (raw: string | undefined, fallback: number) => {
  const n = Number(raw)
  return raw && Number.isInteger(n) && n >= 0 ? n : fallback
}

/**
 * Counts one paid Nansen lookup against the per-IP and global daily caps. Keys start with the UTC
 * day, so server/limits.ts's purge of old `hits` rows also clears these.
 */
export async function countNansenLookup(
  db: D1Like,
  params: { ip: string; salt: string; perIp: number; global: number },
  now = new Date(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const day = now.toISOString().slice(0, 10)
  const ip = await hashIp(params.ip, params.salt)
  const keys: [string, number, string][] = [
    [`${day}:n:all`, params.global, 'Trader stats are at their daily limit; try again tomorrow.'],
    [`${day}:n:ip:${ip}`, params.perIp, 'Too many trader stat lookups from your network today; try again tomorrow.'],
  ]
  const run = () => db.batch(keys.map(([k]) => db.prepare(HIT_SQL).bind(k)))
  let results: Awaited<ReturnType<typeof run>>
  try {
    results = await run()
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e
    await db.batch([db.prepare(HITS_SCHEMA).bind()])
    results = await run()
  }
  for (let i = 0; i < keys.length; i++) {
    const n = (results[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0
    if (n > keys[i][1]) return { ok: false, reason: keys[i][2] }
  }
  return { ok: true }
}

export async function handleNansen(
  request: Request,
  env: NansenEnv,
  path: string[] | string | undefined,
  deps: { fetch?: typeof fetch; cache?: CacheLike | null } = {},
): Promise<Response> {
  const refused = originError(request, env.ALLOWED_ORIGINS)
  if (refused) return json({ error: refused }, 403)
  // Anything missing reads as "not configured" so the front end quietly skips the enrichment.
  const limited = !!env.DB || env.ALLOW_NO_LIMITS === '1'
  if (env.NANSEN_ENABLED !== '1' || !env.NANSEN_API_KEY || !env.SESSION_SECRET || !limited) {
    return json({ error: 'not configured' }, 404)
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const endpoint = resolveEndpoint(path)
  if (!endpoint) return json({ error: 'not found' }, 404)
  const body = endpoint.body(await request.json().catch(() => null))
  if (!body) return json({ error: 'bad request' }, 400)
  if (!(await hasValidSession(request.headers.get('Cookie'), env.SESSION_SECRET))) {
    return json({ error: 'session required' }, 401)
  }

  // POST responses are not cacheable as-is; key the cache on a synthetic GET URL of the rebuilt body.
  const payload = JSON.stringify(body)
  const cacheKey = `https://nansen-cache.internal${endpoint.upstream}?b=${encodeURIComponent(payload)}`
  const cache = deps.cache
  const hit = await cache?.match(cacheKey).catch(() => undefined)
  if (hit) return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'HIT' } })

  // Only cache misses cost credits, so only they count against the caps.
  if (env.DB) {
    let check: Awaited<ReturnType<typeof countNansenLookup>>
    try {
      check = await countNansenLookup(env.DB, {
        ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
        salt: env.SESSION_SECRET,
        perIp: limitFrom(env.NANSEN_PER_IP_DAILY, NANSEN_DEFAULT_LIMITS.perIp),
        global: limitFrom(env.NANSEN_GLOBAL_DAILY, NANSEN_DEFAULT_LIMITS.global),
      })
    } catch {
      // Fail closed: without a working counter we cannot bound spend.
      return json({ error: 'Trader stats are unavailable right now.' }, 503)
    }
    if (!check.ok) return json({ error: check.reason }, 429, { 'Retry-After': '3600' })
  }

  let upstream: Response
  try {
    upstream = await (deps.fetch ?? fetch)(`${NANSEN_API}${endpoint.upstream}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', apikey: env.NANSEN_API_KEY },
      body: payload,
    })
  } catch {
    return json({ error: 'upstream unavailable' }, 502)
  }
  const text = await upstream.text()
  if (!upstream.ok) {
    // Pass the status class through but not Nansen's error body (it can mention plan/credit details).
    return json({ error: 'upstream error', status: upstream.status }, upstream.status === 429 ? 429 : 502)
  }
  if (cache) {
    await cache
      .put(cacheKey, new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${NANSEN_CACHE_SECONDS}` } }))
      .catch(() => undefined)
  }
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'MISS' } })
}
