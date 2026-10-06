// Server-side store for Web Push price alerts, kept in Cloudflare D1 (same DB as server/limits.ts).
//
// Privacy: a row holds only the push subscription (endpoint + keys) and the alert targets.
// No wallet address, no IP. Deleting a subscription deletes its alerts.
import { isAllowedPushEndpoint, isValidPushKeys, type PushKeys } from './webpush.ts'

export type D1Stmt = {
  bind(...values: unknown[]): D1Stmt
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<unknown>
}

export type D1Db = {
  prepare(sql: string): D1Stmt
  batch(statements: D1Stmt[]): Promise<unknown[]>
}

export const PUSH_LIMITS = {
  alertsPerSub: 50,
  /** Armed alerts across everyone (a backstop: per-IP budgets below bound any one network to a small share). */
  activeAlertsTotal: 20_000,
  subsTotal: 20_000,
  /** Sync/unsubscribe calls per IP per day. */
  callsPerIpPerDay: 200,
  /** New push subscriptions per IP (IPv6: per /64) per day. */
  newSubsPerIpPerDay: 2,
  /** Newly armed alerts per IP per day (re-syncing an existing alert is free). */
  newAlertsPerIpPerDay: 100,
  /** Armed alerts expire this long after they were first armed. */
  armedMaxDays: 60,
  /** Checker runs in a row where the CLOB had no midpoint for the token before its alerts are dropped. */
  maxMisses: 30,
  /** Fired alerts are kept this long so a returning tab can learn about them. */
  firedRetentionDays: 30,
  /** Subscriptions not synced for this long are purged with their alerts. */
  idleSubDays: 90,
}

export const PUSH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_subs (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created INTEGER NOT NULL,
    seen INTEGER NOT NULL,
    last_ok INTEGER
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS push_alerts (
    sub_id TEXT NOT NULL,
    id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    op TEXT NOT NULL,
    price REAL NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created INTEGER NOT NULL,
    fired_at INTEGER,
    fired_price REAL,
    misses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sub_id, id)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS push_alerts_armed ON push_alerts (fired_at, token_id, misses)',
  // Cached global counts, refreshed by the checker, so a sync never scans whole tables.
  'CREATE TABLE IF NOT EXISTS push_meta (k TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID',
]

export type AlertTarget = {
  id: string
  tokenId: string
  op: 'above' | 'below'
  price: number
  title: string
  slug: string
  outcome: string
}

export type SyncRequest = { endpoint: string; keys: PushKeys; alerts: AlertTarget[] }

export type StoredAlert = AlertTarget & { subId: string }
export type StoredSub = { id: string; endpoint: string; keys: PushKeys }
export type FiredAlert = { id: string; firedAt: number; price: number | null }

export class PushError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max || CONTROL.test(v)) throw new PushError(`invalid ${field}`)
  return v
}

function onlyKeys(o: Record<string, unknown>, keys: string[], what: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new PushError(`unexpected field in ${what}: ${k.slice(0, 40)}`)
}

function parseKeys(v: unknown): PushKeys {
  if (!isObj(v)) throw new PushError('invalid keys')
  onlyKeys(v, ['p256dh', 'auth'], 'keys')
  const p256dh = text(v.p256dh, 'p256dh', 120)
  const auth = text(v.auth, 'auth', 40)
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) throw new PushError('invalid keys')
  return { p256dh, auth }
}

function parseEndpoint(v: unknown): string {
  if (typeof v !== 'string' || !isAllowedPushEndpoint(v)) throw new PushError('unsupported push endpoint')
  return v
}

export function parseAlert(v: unknown): AlertTarget {
  if (!isObj(v)) throw new PushError('invalid alert')
  onlyKeys(v, ['id', 'tokenId', 'op', 'price', 'title', 'slug', 'outcome'], 'alert')
  if (typeof v.id !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(v.id)) throw new PushError('invalid alert id')
  if (typeof v.tokenId !== 'string' || !/^[0-9]{1,90}$/.test(v.tokenId)) throw new PushError('invalid token id')
  if (v.op !== 'above' && v.op !== 'below') throw new PushError('invalid op')
  // Same range the app allows (0.1¢ to 99.9¢).
  if (typeof v.price !== 'number' || !Number.isFinite(v.price) || v.price < 0.001 || v.price > 0.999) throw new PushError('invalid price')
  return {
    id: v.id,
    tokenId: v.tokenId,
    op: v.op,
    price: v.price,
    title: text(v.title, 'title', 300),
    slug: text(v.slug, 'slug', 200),
    outcome: text(v.outcome, 'outcome', 80),
  }
}

/** Strict parse of POST /api/push/subscribe. Also checks that p256dh is a real P-256 point. */
export async function parseSyncRequest(body: unknown): Promise<SyncRequest> {
  if (!isObj(body)) throw new PushError('invalid body')
  onlyKeys(body, ['endpoint', 'keys', 'alerts'], 'body')
  const endpoint = parseEndpoint(body.endpoint)
  const keys = parseKeys(body.keys)
  if (!(await isValidPushKeys(keys))) throw new PushError('invalid keys')
  if (!Array.isArray(body.alerts)) throw new PushError('invalid alerts')
  if (body.alerts.length > PUSH_LIMITS.alertsPerSub) throw new PushError(`at most ${PUSH_LIMITS.alertsPerSub} alerts`)
  const alerts = body.alerts.map(parseAlert)
  if (new Set(alerts.map((a) => a.id)).size !== alerts.length) throw new PushError('duplicate alert id')
  return { endpoint, keys, alerts }
}

export function parseUnsubscribeRequest(body: unknown): { endpoint: string } {
  if (!isObj(body)) throw new PushError('invalid body')
  onlyKeys(body, ['endpoint'], 'body')
  // Any endpoint string may be deleted (it can only match a row its owner created).
  if (typeof body.endpoint !== 'string' || body.endpoint.length === 0 || body.endpoint.length > 1024) throw new PushError('invalid endpoint')
  return { endpoint: body.endpoint }
}

async function sha256Hex(s: string, bytes = 16): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d).slice(0, bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Row id of a subscription: a hash of its endpoint, so ids never reveal the endpoint in logs. */
export const subscriptionId = (endpoint: string) => sha256Hex(`push-sub:${endpoint}`)


// ---------- CLOB prices ----------

export const CLOB_API = 'https://clob.polymarket.com'
export const MIDPOINT_CHUNK = 50

/** One POST /midpoints call (≤ 50 tokens) → { [tokenId]: price }. Tokens without a book are omitted. Throws on HTTP errors. */
export async function fetchMidpointChunk(tokens: string[], fetcher: typeof fetch = fetch): Promise<Record<string, number>> {
  const res = await fetcher(`${CLOB_API}/midpoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.map((token_id) => ({ token_id }))),
  })
  if (!res.ok) throw new Error(`CLOB midpoints: HTTP ${res.status}`)
  const body = (await res.json()) as Record<string, string> | null
  const out: Record<string, number> = {}
  for (const [id, v] of Object.entries(body ?? {})) {
    const n = Number(v)
    if (Number.isFinite(n)) out[id] = n
  }
  return out
}

/** `knownTokens` for syncSubscription: the tokens the CLOB has a live midpoint for. */
export function clobKnownTokens(fetcher: typeof fetch = fetch) {
  return async (ids: string[]): Promise<Set<string>> => {
    const known = new Set<string>()
    for (let i = 0; i < ids.length; i += MIDPOINT_CHUNK) {
      for (const id of Object.keys(await fetchMidpointChunk(ids.slice(i, i + MIDPOINT_CHUNK), fetcher))) known.add(id)
    }
    return known
  }
}

// ---------- per-IP budgets (salted-hash counters in the `hits` table, purged with server/limits.ts) ----------

/** IPv4 as is; IPv6 reduced to its /64, which is what one customer usually gets. */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip
  const [head, tail] = ip.toLowerCase().split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

async function countHit(db: D1Db, key: string, by = 1): Promise<number> {
  const stmt = () =>
    db.prepare('INSERT INTO hits (k, n) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + ?2 RETURNING n').bind(key, by).first<{ n: number }>()
  let row: { n: number } | null
  try {
    row = await stmt()
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e
    await db.prepare('CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID').run()
    row = await stmt()
  }
  return row?.n ?? 0
}

async function ipKey(kind: string, ip: string, salt: string, now: number): Promise<string> {
  // Keys start with the UTC day so server/limits.ts purges them after a few days.
  return `${new Date(now).toISOString().slice(0, 10)}:p:${kind}:${await sha256Hex(`${salt}:${ipBucket(ip)}`, 12)}`
}

export async function countPushCall(db: D1Db, ip: string, salt: string, now = Date.now()): Promise<boolean> {
  return (await countHit(db, await ipKey('ip', ip, salt, now))) <= PUSH_LIMITS.callsPerIpPerDay
}

// ---------- store ----------

async function withSchema<T>(db: D1Db, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    // Fresh database: create the tables once and retry.
    if (!/no such table/i.test(String(e))) throw e
    await ensurePushSchema(db)
    return fn()
  }
}

export async function ensurePushSchema(db: D1Db) {
  await db.batch(PUSH_SCHEMA.map((s) => db.prepare(s)))
}

async function readCounts(db: D1Db): Promise<{ subs: number; armed: number }> {
  const rows = (await db.prepare("SELECT k, n FROM push_meta WHERE k IN ('subs', 'armed')").all<{ k: string; n: number }>()).results
  const get = (k: string) => rows.find((r) => r.k === k)?.n ?? 0
  return { subs: get('subs'), armed: get('armed') }
}

/** Recounts the cached totals. The checker runs this every few minutes; syncs only add deltas. */
export async function refreshCounts(db: D1Db) {
  await withSchema(db, async () => {
    const subs = await db.prepare('SELECT COUNT(*) AS n FROM push_subs').first<{ n: number }>()
    const armed = await db.prepare('SELECT COUNT(*) AS n FROM push_alerts WHERE fired_at IS NULL').first<{ n: number }>()
    const set = 'INSERT INTO push_meta (k, n) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET n = excluded.n'
    await db.batch([db.prepare(set).bind('subs', subs?.n ?? 0), db.prepare(set).bind('armed', armed?.n ?? 0)])
  })
}

export type SyncOptions = {
  now?: number
  /** Caller's IP and hash salt for the per-IP budgets. Omitted only by the dev server. */
  client?: { ip: string; salt: string }
  /** Returns the subset of token ids the CLOB knows. Alerts on unknown tokens are dropped, not stored. */
  knownTokens?: (ids: string[]) => Promise<Set<string>>
}

// An alert keeps its fired state, arm time and miss count only while its target is unchanged.
const SAME = 'push_alerts.token_id = excluded.token_id AND push_alerts.op = excluded.op AND abs(push_alerts.price - excluded.price) < 1e-9'
const UPSERT_ALERT =
  'INSERT INTO push_alerts (sub_id, id, token_id, op, price, title, slug, outcome, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ' +
  'ON CONFLICT(sub_id, id) DO UPDATE SET title = excluded.title, slug = excluded.slug, outcome = excluded.outcome, ' +
  `fired_at = CASE WHEN ${SAME} THEN push_alerts.fired_at ELSE NULL END, ` +
  `fired_price = CASE WHEN ${SAME} THEN push_alerts.fired_price ELSE NULL END, ` +
  `created = CASE WHEN ${SAME} THEN push_alerts.created ELSE excluded.created END, ` +
  `misses = CASE WHEN ${SAME} THEN push_alerts.misses ELSE 0 END, ` +
  'token_id = excluded.token_id, op = excluded.op, price = excluded.price'
const ADD_COUNT = 'INSERT INTO push_meta (k, n) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + ?2'

/**
 * Upserts the subscription and replaces its alert set in one transaction. An alert the checker has
 * already fired keeps its fired state (and is returned) even if the checker fires it mid-sync, so
 * a sync can never re-arm it.
 */
export async function syncSubscription(db: D1Db, req: SyncRequest, opts: SyncOptions = {}): Promise<{ fired: FiredAlert[]; dropped: string[] }> {
  const now = opts.now ?? Date.now()
  return withSchema(db, async () => {
    const subId = await subscriptionId(req.endpoint)
    const isNew = !(await db.prepare('SELECT id FROM push_subs WHERE id = ?1').bind(subId).first())
    const prev = (await db.prepare('SELECT id, token_id FROM push_alerts WHERE sub_id = ?1').bind(subId).all<{ id: string; token_id: string }>()).results
    const prevIds = new Set(prev.map((p) => p.id))
    const prevTokens = new Set(prev.map((p) => p.token_id))

    // Tokens this subscription hasn't used before must exist on the CLOB (one /midpoints call).
    let alerts = req.alerts
    const dropped: string[] = []
    const newTokens = [...new Set(alerts.map((a) => a.tokenId).filter((t) => !prevTokens.has(t)))]
    if (opts.knownTokens && newTokens.length > 0) {
      let known: Set<string>
      try {
        known = await opts.knownTokens(newTokens)
      } catch {
        throw new PushError('could not check markets right now; try again shortly', 503)
      }
      alerts = alerts.filter((a) => {
        const ok = prevTokens.has(a.tokenId) || known.has(a.tokenId)
        if (!ok) dropped.push(a.id)
        return ok
      })
    }
    const added = alerts.filter((a) => !prevIds.has(a.id)).length

    const counts = await readCounts(db)
    if (isNew && counts.subs >= PUSH_LIMITS.subsTotal) throw new PushError('alert service is at capacity; try again later', 503)
    if (counts.armed + added > PUSH_LIMITS.activeAlertsTotal) throw new PushError('alert service is at capacity; try again later', 503)
    if (opts.client) {
      const { ip, salt } = opts.client
      if (isNew && (await countHit(db, await ipKey('new', ip, salt, now))) > PUSH_LIMITS.newSubsPerIpPerDay) {
        throw new PushError('too many new alert subscriptions from your network today', 429)
      }
      if (added > 0 && (await countHit(db, await ipKey('alerts', ip, salt, now), added)) > PUSH_LIMITS.newAlertsPerIpPerDay) {
        throw new PushError('too many new alerts from your network today', 429)
      }
    }

    const ids = alerts.map((a) => a.id)
    const stmts = [
      db
        .prepare(
          'INSERT INTO push_subs (id, endpoint, p256dh, auth, created, seen) VALUES (?1, ?2, ?3, ?4, ?5, ?5) ' +
            'ON CONFLICT(id) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, seen = excluded.seen',
        )
        .bind(subId, req.endpoint, req.keys.p256dh, req.keys.auth, now),
      ids.length > 0
        ? db.prepare(`DELETE FROM push_alerts WHERE sub_id = ?1 AND id NOT IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`).bind(subId, ...ids)
        : db.prepare('DELETE FROM push_alerts WHERE sub_id = ?1').bind(subId),
      ...alerts.map((a) => db.prepare(UPSERT_ALERT).bind(subId, a.id, a.tokenId, a.op, a.price, a.title, a.slug, a.outcome, now)),
      // Keep the cached totals roughly current between checker recounts.
      db.prepare(ADD_COUNT).bind('armed', added),
      db.prepare(ADD_COUNT).bind('subs', isNew ? 1 : 0),
      db.prepare('SELECT id, fired_at, fired_price FROM push_alerts WHERE sub_id = ?1 AND fired_at IS NOT NULL').bind(subId),
    ]
    // D1 runs a batch as one transaction.
    const results = (await db.batch(stmts)) as { results?: { id: string; fired_at: number; fired_price: number | null }[] }[]
    const fired = (results.at(-1)?.results ?? []).map((r) => ({ id: r.id, firedAt: r.fired_at, price: r.fired_price }))
    return { fired, dropped }
  })
}

/** Deletes a subscription and all its alerts. Returns true when something was deleted. */
export async function deleteSubscription(db: D1Db, endpoint: string): Promise<boolean> {
  return deleteSubscriptionById(db, await subscriptionId(endpoint))
}

export async function deleteSubscriptionById(db: D1Db, subId: string): Promise<boolean> {
  return withSchema(db, async () => {
    const found = await db.prepare('SELECT id FROM push_subs WHERE id = ?1').bind(subId).first()
    await db.batch([db.prepare('DELETE FROM push_alerts WHERE sub_id = ?1').bind(subId), db.prepare('DELETE FROM push_subs WHERE id = ?1').bind(subId)])
    return !!found
  })
}

/** Distinct tokens with armed alerts (a covering-index scan), with the highest miss count per token. */
export async function loadArmedTokens(db: D1Db, limit = PUSH_LIMITS.activeAlertsTotal): Promise<{ tokenId: string; misses: number }[]> {
  return withSchema(db, async () => {
    const rows = (
      await db
        .prepare('SELECT token_id, MAX(misses) AS misses FROM push_alerts WHERE fired_at IS NULL GROUP BY token_id LIMIT ?1')
        .bind(limit)
        .all<{ token_id: string; misses: number }>()
    ).results
    return rows.map((r) => ({ tokenId: r.token_id, misses: r.misses }))
  })
}

type AlertRow = { sub_id: string; id: string; token_id: string; op: 'above' | 'below'; price: number; title: string; slug: string; outcome: string }

/** Armed alerts whose target the given midpoints have reached (same 1e-9 tolerance as the app). */
export async function loadDueAlerts(db: D1Db, prices: Record<string, number>): Promise<StoredAlert[]> {
  const sql =
    'SELECT sub_id, id, token_id, op, price, title, slug, outcome FROM push_alerts WHERE fired_at IS NULL AND token_id = ?1 ' +
    "AND ((op = 'above' AND price <= ?2 + 1e-9) OR (op = 'below' AND price >= ?2 - 1e-9))"
  const entries = Object.entries(prices)
  const out: StoredAlert[] = []
  for (let i = 0; i < entries.length; i += 50) {
    const batch = (await db.batch(entries.slice(i, i + 50).map(([t, p]) => db.prepare(sql).bind(t, p)))) as { results?: AlertRow[] }[]
    for (const r of batch.flatMap((b) => b.results ?? [])) {
      out.push({ subId: r.sub_id, id: r.id, tokenId: r.token_id, op: r.op, price: r.price, title: r.title, slug: r.slug, outcome: r.outcome })
    }
  }
  return out
}

/**
 * Tokens the CLOB returned no midpoint for (in a request that succeeded) get a miss; tokens priced
 * again reset to zero. Alerts on a token that kept missing are dropped: they can never fire.
 */
export async function recordMisses(db: D1Db, missing: string[], recovered: string[]) {
  const stmts: D1Stmt[] = []
  const inList = (sql: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90)
      stmts.push(db.prepare(sql.replace('$IN', chunk.map((_, j) => `?${j + 1}`).join(', '))).bind(...chunk))
    }
  }
  inList('UPDATE push_alerts SET misses = misses + 1 WHERE fired_at IS NULL AND token_id IN ($IN)', missing)
  inList('UPDATE push_alerts SET misses = 0 WHERE fired_at IS NULL AND misses > 0 AND token_id IN ($IN)', recovered)
  if (missing.length > 0) stmts.push(db.prepare('DELETE FROM push_alerts WHERE fired_at IS NULL AND misses >= ?1').bind(PUSH_LIMITS.maxMisses))
  if (stmts.length > 0) await db.batch(stmts)
}

export async function loadSubscriptions(db: D1Db, ids: string[]): Promise<Map<string, StoredSub>> {
  const out = new Map<string, StoredSub>()
  const unique = [...new Set(ids)]
  // D1 allows at most 100 bound parameters per statement.
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90)
    const marks = chunk.map((_, j) => `?${j + 1}`).join(', ')
    const rows = (
      await db
        .prepare(`SELECT id, endpoint, p256dh, auth FROM push_subs WHERE id IN (${marks})`)
        .bind(...chunk)
        .all<{ id: string; endpoint: string; p256dh: string; auth: string }>()
    ).results
    for (const r of rows) out.set(r.id, { id: r.id, endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } })
  }
  return out
}

/** Marks an alert fired before sending, so overlapping runs can't push it twice. False if already claimed. */
export async function claimAlert(db: D1Db, subId: string, id: string, price: number, now = Date.now()): Promise<boolean> {
  const row = await db
    .prepare('UPDATE push_alerts SET fired_at = ?1, fired_price = ?2 WHERE sub_id = ?3 AND id = ?4 AND fired_at IS NULL RETURNING id')
    .bind(now, price, subId, id)
    .first()
  return !!row
}

/** Re-arms a claimed alert after a transient delivery failure. */
export async function releaseAlert(db: D1Db, subId: string, id: string) {
  await db.prepare('UPDATE push_alerts SET fired_at = NULL, fired_price = NULL WHERE sub_id = ?1 AND id = ?2').bind(subId, id).run()
}

export async function markDelivered(db: D1Db, subId: string, now = Date.now()) {
  await db.prepare('UPDATE push_subs SET last_ok = ?1 WHERE id = ?2').bind(now, subId).run()
}

/** Drops old fired alerts, armed alerts past their lifetime and long-idle subscriptions, then recounts. */
export async function purgeStale(db: D1Db, now = Date.now()) {
  const day = 86_400_000
  await withSchema(db, () =>
    db.batch([
      db.prepare('DELETE FROM push_alerts WHERE fired_at IS NOT NULL AND fired_at < ?1').bind(now - PUSH_LIMITS.firedRetentionDays * day),
      db.prepare('DELETE FROM push_alerts WHERE fired_at IS NULL AND created < ?1').bind(now - PUSH_LIMITS.armedMaxDays * day),
      db.prepare('DELETE FROM push_alerts WHERE sub_id IN (SELECT id FROM push_subs WHERE seen < ?1)').bind(now - PUSH_LIMITS.idleSubDays * day),
      db.prepare('DELETE FROM push_subs WHERE seen < ?1').bind(now - PUSH_LIMITS.idleSubDays * day),
    ]),
  )
  await refreshCounts(db)
}
