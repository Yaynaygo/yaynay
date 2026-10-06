// Fallback for LI.FI quotes once a user's network has used LI.FI's anonymous quota (75 quotes per two
// hours per IP). Our API key stays on the server, as LI.FI requires. Only top-up quotes are forwarded:
// destination Arc USDC, paid to the requester's own address, and the browser re-checks the quote and
// its calldata before anything is signed, exactly as for a direct quote.
import { json, originError } from './guard.ts'
import type { D1Like } from './limits.ts'
import { hasValidSession } from './session.ts'

export type LifiEnv = {
  LIFI_API_KEY?: string
  /** Proxied quotes per IP per UTC day (default 300). */
  LIFI_PER_IP_DAILY?: string
  /** Proxied quotes per UTC day across everyone (default 20000; the key allows 100 a minute). */
  LIFI_GLOBAL_DAILY?: string
  SESSION_SECRET?: string
  ALLOWED_ORIGINS?: string
  DB?: D1Like
  /** Set to "1" only for previews without D1. */
  ALLOW_NO_LIMITS?: string
}

export const LIFI_DEFAULT_LIMITS = { perIp: 300, global: 20000 }
export const LIFI_UPSTREAM = 'https://li.quest/v1/quote'
export const LIFI_CACHE_SECONDS = 15

const ARC = '5042'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
/** Source chains the top-up offers: Ethereum, Optimism, BNB, Polygon, Base, Arbitrum, Tempo, Arc. */
const SOURCE_CHAINS = new Set(['1', '10', '56', '137', '8453', '42161', '4217', '5042'])
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export type CacheLike = {
  match(key: Request | string): Promise<Response | undefined>
  put(key: Request | string, res: Response): Promise<void>
}

/** Rebuilds the quote query from scratch, or returns null if anything is outside what the top-up asks. */
export function quoteQuery(params: URLSearchParams): URLSearchParams | null {
  const allowed = new Set(['fromChain', 'toChain', 'fromToken', 'toToken', 'fromAmount', 'fromAddress', 'toAddress', 'slippage', 'integrator'])
  for (const key of params.keys()) if (!allowed.has(key)) return null
  const get = (k: string) => params.get(k) ?? ''
  const fromChain = get('fromChain')
  const fromToken = get('fromToken')
  const fromAmount = get('fromAmount')
  const fromAddress = get('fromAddress')
  const toAddress = get('toAddress')
  const slippage = Number(get('slippage'))
  if (!SOURCE_CHAINS.has(fromChain) || get('toChain') !== ARC) return null
  if (get('toToken').toLowerCase() !== ARC_USDC || !ADDRESS.test(fromToken)) return null
  if (!/^[1-9][0-9]{0,39}$/.test(fromAmount)) return null
  if (!ADDRESS.test(fromAddress) || fromAddress.toLowerCase() !== toAddress.toLowerCase()) return null
  if (!(slippage > 0 && slippage <= 0.03)) return null
  if (get('integrator') !== 'yaynay') return null
  return new URLSearchParams({
    fromChain,
    toChain: ARC,
    fromToken: fromToken.toLowerCase(),
    toToken: ARC_USDC,
    fromAmount,
    fromAddress: fromAddress.toLowerCase(),
    toAddress: fromAddress.toLowerCase(),
    slippage: String(slippage),
    integrator: 'yaynay',
  })
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

/** Counts one proxied quote against the daily caps. Keys start with the UTC day, so the existing purge clears them. */
export async function countLifiQuote(
  db: D1Like,
  params: { ip: string; salt: string; perIp: number; global: number },
  now = new Date(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const day = now.toISOString().slice(0, 10)
  const ip = await hashIp(params.ip, params.salt)
  const keys: [string, number, string][] = [
    [`${day}:l:all`, params.global, 'Top-up quotes are at their daily limit; try again tomorrow.'],
    [`${day}:l:ip:${ip}`, params.perIp, 'Too many top-up quotes from your network today; try again tomorrow.'],
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

export async function handleLifiQuote(
  request: Request,
  env: LifiEnv,
  deps: { fetch?: typeof fetch; cache?: CacheLike | null } = {},
): Promise<Response> {
  const refused = originError(request, env.ALLOWED_ORIGINS)
  if (refused) return json({ message: refused }, 403)
  const limited = !!env.DB || env.ALLOW_NO_LIMITS === '1'
  if (!env.LIFI_API_KEY || !env.SESSION_SECRET || !limited) return json({ message: 'not configured' }, 404)
  // POST, like our other endpoints: browsers always send Origin on POST, so the origin guard holds.
  if (request.method !== 'POST') return json({ message: 'method not allowed' }, 405)

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const fields = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : null
  const query = fields && fields.every(([, v]) => typeof v === 'string' || typeof v === 'number')
    ? quoteQuery(new URLSearchParams(fields.map(([k, v]): [string, string] => [k, String(v)])))
    : null
  if (!query) return json({ message: 'bad request' }, 400)
  if (!(await hasValidSession(request.headers.get('Cookie'), env.SESSION_SECRET))) {
    return json({ message: 'session required' }, 401)
  }

  const upstreamUrl = `${LIFI_UPSTREAM}?${query}`
  const cache = deps.cache
  const hit = await cache?.match(upstreamUrl).catch(() => undefined)
  if (hit) return new Response(hit.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'HIT' } })

  if (env.DB) {
    let check: Awaited<ReturnType<typeof countLifiQuote>>
    try {
      check = await countLifiQuote(env.DB, {
        ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
        salt: env.SESSION_SECRET,
        perIp: limitFrom(env.LIFI_PER_IP_DAILY, LIFI_DEFAULT_LIMITS.perIp),
        global: limitFrom(env.LIFI_GLOBAL_DAILY, LIFI_DEFAULT_LIMITS.global),
      })
    } catch {
      return json({ message: 'Top-up quotes are unavailable right now.' }, 503)
    }
    if (!check.ok) return json({ message: check.reason }, 429, { 'Retry-After': '3600' })
  }

  let upstream: Response
  try {
    upstream = await (deps.fetch ?? fetch)(upstreamUrl, { headers: { Accept: 'application/json', 'x-lifi-api-key': env.LIFI_API_KEY } })
  } catch {
    return json({ message: 'LI.FI is unreachable right now.' }, 502)
  }
  const text = await upstream.text()
  if (!upstream.ok) {
    // Pass LI.FI's own message (e.g. "No available quotes") but nothing else from upstream.
    let message = `LI.FI quote failed (${upstream.status})`
    try {
      const m = (JSON.parse(text) as { message?: unknown }).message
      if (typeof m === 'string') message = m.slice(0, 300)
    } catch {
      // keep the generic message
    }
    const status = upstream.status === 429 ? 429 : upstream.status === 404 ? 422 : 502
    return json({ message }, status, upstream.status === 429 ? { 'Retry-After': upstream.headers.get('Retry-After') ?? '600' } : {})
  }
  const res = new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${LIFI_CACHE_SECONDS}` } })
  await cache?.put(upstreamUrl, res.clone()).catch(() => undefined)
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': 'MISS' } })
}
