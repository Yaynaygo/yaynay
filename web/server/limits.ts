// Daily caps on signed write requests, kept in Cloudflare D1 (free plan: 100k writes/day).
// Only writes are counted: the SDK also routes every read through the signer.
//
// The table is created on first use (same DDL as web/schema.sql).

const SCHEMA = 'CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID'

export type D1Like = {
  prepare(sql: string): { bind(...values: unknown[]): unknown }
  batch(statements: unknown[]): Promise<{ results?: unknown[] }[]>
}

export const LIMITS = {
  /** Signed writes (orders, cancels, relayer txs) per IP per day. */
  writesPerIp: 300,
  /** Relayer transactions per day across everyone; Polymarket's Unverified tier allows 100. */
  relayerGlobal: 90,
  /** Relayer transactions per IP per day (onboarding needs 2, each withdraw/redeem 1). */
  relayerPerIp: 12,
  /** Relayer transactions per signing wallet per day. */
  relayerPerWallet: 10,
}

export type LimitCheck = { ok: true } | { ok: false; reason: string }

/** Days of counters kept; older rows are purged so no hashed IP outlives a few days. */
const RETENTION_DAYS = 3

/** One-way, salted hash so the database never holds a raw IP address. */
async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`))
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function countAndCheck(
  db: D1Like,
  params: { ip: string; isRelayer: boolean; wallet?: string; salt: string },
  now = new Date(),
): Promise<LimitCheck> {
  const day = now.toISOString().slice(0, 10)
  const ip = await hashIp(params.ip, params.salt)
  const keys: [string, number, string][] = [[`${day}:w:ip:${ip}`, LIMITS.writesPerIp, 'too many requests from your network today']]
  if (params.isRelayer) {
    keys.push([`${day}:r:all`, LIMITS.relayerGlobal, 'the gasless relayer is at its daily limit; try again tomorrow'])
    keys.push([`${day}:r:ip:${ip}`, LIMITS.relayerPerIp, 'too many gasless transactions from your network today'])
    if (params.wallet) {
      keys.push([`${day}:r:from:${params.wallet}`, LIMITS.relayerPerWallet, 'too many gasless transactions for this wallet today'])
    }
  }
  const stmt = 'INSERT INTO hits (k, n) VALUES (?1, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n'
  const run = () => db.batch(keys.map(([k]) => db.prepare(stmt).bind(k)))
  let results: Awaited<ReturnType<typeof run>>
  try {
    results = await run()
  } catch (e) {
    // First request on a fresh database: create the table and try once more.
    if (!/no such table/i.test(String(e))) throw e
    await db.batch([db.prepare(SCHEMA).bind()])
    results = await run()
  }
  // Keys start with the UTC day, so a string comparison finds expired rows. Purge occasionally.
  if (Math.random() < 0.02) {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
    await db.batch([db.prepare('DELETE FROM hits WHERE k < ?1').bind(cutoff)]).catch(() => {})
  }
  for (let i = 0; i < keys.length; i++) {
    const n = (results[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0
    if (n > keys[i][1]) return { ok: false, reason: keys[i][2] }
  }
  return { ok: true }
}
