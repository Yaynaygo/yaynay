import { beforeEach, describe, expect, it } from 'vitest'
import { claimAlert, deleteSubscription, ipBucket, parseSyncRequest, PushError, refreshCounts, subscriptionId, syncSubscription, PUSH_LIMITS, type D1Db, type D1Stmt } from '../../server/pushStore.ts'
import { b64urlDecode } from '../../server/webpush.ts'
import { runCheck, type Env } from './index.ts'
import { sqliteD1 } from './sqliteD1.ts'
import { decryptPayload, makeSubscriber } from './testing.ts'

const TOKEN_A = '1'.repeat(77)
const TOKEN_B = '2'.repeat(77)
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-endpoint'

async function vapidEnv(db: D1Db): Promise<Env> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return { DB: db, VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: d, VAPID_SUBJECT: 'mailto:ops@example.com' }
}

const alert = (id: string, tokenId: string, op: 'above' | 'below', price: number) => ({
  id,
  tokenId,
  op,
  price,
  title: 'Will it rain in Paris?',
  slug: 'rain-paris',
  outcome: 'Yes',
})

type Call = { url: string; init?: RequestInit }

function mockFetch(mids: Record<string, string>, pushStatus = 201) {
  const calls: Call[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/midpoints')) return new Response(JSON.stringify(mids), { status: 200 })
    return new Response('', { status: pushStatus })
  }) as typeof fetch
  return { calls, fetcher, pushes: () => calls.filter((c) => !c.url.endsWith('/midpoints')) }
}

describe('push store + checker', () => {
  let db: D1Db
  let env: Env
  let sub: Awaited<ReturnType<typeof makeSubscriber>>

  beforeEach(async () => {
    db = sqliteD1()
    env = await vapidEnv(db)
    sub = await makeSubscriber()
  })

  it('fires a crossing once, with an encrypted payload the browser can read', async () => {
    const req = await parseSyncRequest({ endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a1', TOKEN_A, 'above', 0.7), alert('a2', TOKEN_B, 'below', 0.2)] })
    expect(await syncSubscription(db, req)).toEqual({ fired: [], dropped: [] })

    const m = mockFetch({ [TOKEN_A]: '0.72', [TOKEN_B]: '0.5' })
    const s = await runCheck(env, { fetcher: m.fetcher, now: Date.UTC(2026, 9, 6, 12, 1) })
    expect(s).toMatchObject({ armed: 2, due: 1, sent: 1, gone: 0, failed: 0 })
    const [push] = m.pushes()
    expect(push.url).toBe(ENDPOINT)
    const h = push.init?.headers as Record<string, string>
    expect(h['Content-Encoding']).toBe('aes128gcm')
    expect(h.TTL).toBe('3600')
    expect(h.Urgency).toBe('high')
    expect(h.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/)
    const plain = await decryptPayload(push.init?.body as Uint8Array<ArrayBuffer>, sub.privateKey, sub.keys.p256dh, sub.keys.auth)
    expect(JSON.parse(plain)).toEqual({ title: 'Yes hit 72¢', body: 'Will it rain in Paris?', url: '/#/market/rain-paris', tag: 'alert:a1', alertId: 'a1', price: 0.72 })

    // Second run: already fired, nothing sent.
    const m2 = mockFetch({ [TOKEN_A]: '0.75', [TOKEN_B]: '0.5' })
    expect(await runCheck(env, { fetcher: m2.fetcher })).toMatchObject({ armed: 1, sent: 0 })

    // A returning tab re-sends the same alert: it stays fired and the tab learns about it.
    const again = await syncSubscription(db, req)
    expect(again.fired).toEqual([{ id: 'a1', firedAt: Date.UTC(2026, 9, 6, 12, 1), price: 0.72 }])
    expect(await runCheck(env, { fetcher: mockFetch({ [TOKEN_A]: '0.9' }).fetcher })).toMatchObject({ sent: 0 })
  })

  it('purges the subscription on 410 and re-arms on 5xx', async () => {
    await syncSubscription(db, await parseSyncRequest({ endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a1', TOKEN_A, 'above', 0.5)] }))
    expect(await runCheck(env, { fetcher: mockFetch({ [TOKEN_A]: '0.6' }, 503).fetcher })).toMatchObject({ failed: 1 })
    expect(await runCheck(env, { fetcher: mockFetch({ [TOKEN_A]: '0.6' }, 410).fetcher })).toMatchObject({ gone: 1 })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM push_subs').first()).toEqual({ n: 0 })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM push_alerts').first()).toEqual({ n: 0 })
  })

  it('replaces the alert set and deletes everything on unsubscribe', async () => {
    await syncSubscription(db, await parseSyncRequest({ endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a1', TOKEN_A, 'above', 0.5), alert('a2', TOKEN_B, 'above', 0.5)] }))
    await syncSubscription(db, await parseSyncRequest({ endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a2', TOKEN_B, 'above', 0.5)] }))
    expect((await db.prepare('SELECT id FROM push_alerts').all()).results.map((r) => (r as { id: string }).id)).toEqual(['a2'])
    expect(await deleteSubscription(db, ENDPOINT)).toBe(true)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM push_alerts').first()).toEqual({ n: 0 })
    expect(await deleteSubscription(db, ENDPOINT)).toBe(false)
  })

  it('validates requests strictly', async () => {
    const base = { endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a1', TOKEN_A, 'above', 0.5)] }
    const bad = [
      { ...base, endpoint: 'https://example.com/push' },
      { ...base, extra: 1 },
      { ...base, keys: { ...sub.keys, auth: 'AAAA' } },
      { ...base, alerts: [{ ...alert('a1', TOKEN_A, 'above', 0.5), wallet: '0xabc' }] },
      { ...base, alerts: [alert('a1', '0xabc', 'above', 0.5)] },
      { ...base, alerts: [alert('a1', TOKEN_A, 'above', 1)] },
      { ...base, alerts: [alert('a1', TOKEN_A, 'above', 0.5), alert('a1', TOKEN_B, 'above', 0.5)] },
      { ...base, alerts: Array.from({ length: PUSH_LIMITS.alertsPerSub + 1 }, (_, i) => alert(`a${i}`, TOKEN_A, 'above', 0.5)) },
      { ...base, alerts: [{ ...alert('a1', TOKEN_A, 'above', 0.5), title: 'x\u0000' }] },
    ]
    for (const b of bad) await expect(parseSyncRequest(b)).rejects.toBeInstanceOf(PushError)
    expect(b64urlDecode(sub.keys.auth).length).toBe(16)
  })

  const ep = (n: number | string) => `https://fcm.googleapis.com/fcm/send/fake-${n}`
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => alert(`${prefix}${i}`, TOKEN_A, 'above', 0.5))
  const client = { ip: '203.0.113.7', salt: 'salt' }

  it('limits one IP to 2 new subscriptions a day (IPv6 by /64)', async () => {
    const sync = async (n: number, ip = client.ip) =>
      syncSubscription(db, await parseSyncRequest({ endpoint: ep(n), keys: sub.keys, alerts: [] }), { client: { ...client, ip } })
    await sync(1)
    await sync(2)
    await sync(1) // re-sync of an existing subscription is not new
    await expect(sync(3)).rejects.toMatchObject({ status: 429 })
    await sync(4, '198.51.100.1') // another network is unaffected
    await sync(5, '2001:db8:1:2::1')
    await sync(6, '2001:0db8:0001:0002:ffff::9')
    await expect(sync(7, '2001:db8:1:2:abcd::')).rejects.toMatchObject({ status: 429 })
  })

  it('limits newly armed alerts per IP; re-syncing the same alerts is free', async () => {
    const opts = { client }
    await syncSubscription(db, await parseSyncRequest({ endpoint: ep(1), keys: sub.keys, alerts: many('x', 50) }), opts)
    await syncSubscription(db, await parseSyncRequest({ endpoint: ep(2), keys: sub.keys, alerts: many('y', 50) }), opts)
    await syncSubscription(db, await parseSyncRequest({ endpoint: ep(2), keys: sub.keys, alerts: many('y', 50) }), opts)
    await expect(syncSubscription(db, await parseSyncRequest({ endpoint: ep(2), keys: sub.keys, alerts: many('z', 1) }), opts)).rejects.toMatchObject({ status: 429 })
    expect(PUSH_LIMITS.activeAlertsTotal).toBeGreaterThanOrEqual(100 * PUSH_LIMITS.newAlertsPerIpPerDay)
  })

  it('enforces the global caps from cached counts, without scanning tables per sync', async () => {
    const sqls: string[] = []
    const spy: D1Db = { prepare: (sql: string): D1Stmt => (sqls.push(sql), db.prepare(sql)), batch: (s) => db.batch(s) }
    await syncSubscription(spy, await parseSyncRequest({ endpoint: ep(1), keys: sub.keys, alerts: many('x', 3) }))
    expect(sqls.filter((q) => /COUNT\(/i.test(q))).toEqual([])
    await refreshCounts(db)
    expect((await db.prepare("SELECT n FROM push_meta WHERE k = 'armed'").first())?.n).toBe(3)
    await db.prepare("UPDATE push_meta SET n = ?1 WHERE k = 'armed'").bind(PUSH_LIMITS.activeAlertsTotal - 1).run()
    await expect(syncSubscription(db, await parseSyncRequest({ endpoint: ep(2), keys: sub.keys, alerts: many('y', 2) }))).rejects.toMatchObject({ status: 503 })
    await db.prepare("UPDATE push_meta SET n = ?1 WHERE k = 'subs'").bind(PUSH_LIMITS.subsTotal).run()
    await expect(syncSubscription(db, await parseSyncRequest({ endpoint: ep(3), keys: sub.keys, alerts: [] }))).rejects.toMatchObject({ status: 503 })
    // Existing subscriptions keep working at the cap.
    await syncSubscription(db, await parseSyncRequest({ endpoint: ep(1), keys: sub.keys, alerts: many('x', 3) }))
  })

  it('drops alerts on tokens the CLOB does not know, checking only new tokens', async () => {
    const asked: string[][] = []
    const knownTokens = async (ids: string[]) => (asked.push(ids), new Set([TOKEN_A]))
    const req = await parseSyncRequest({ endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a1', TOKEN_A, 'above', 0.5), alert('a2', TOKEN_B, 'above', 0.5)] })
    expect(await syncSubscription(db, req, { knownTokens })).toEqual({ fired: [], dropped: ['a2'] })
    expect((await db.prepare('SELECT id FROM push_alerts').all()).results).toEqual([{ id: 'a1' }])
    await syncSubscription(db, await parseSyncRequest({ endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a1', TOKEN_A, 'above', 0.5)] }), { knownTokens })
    expect(asked).toEqual([[TOKEN_A, TOKEN_B]])
    const down = async () => Promise.reject(new Error('CLOB down'))
    await expect(syncSubscription(db, req, { knownTokens: down })).rejects.toMatchObject({ status: 503 })
  })

  it('never re-arms an alert the checker fires while a sync is in flight', async () => {
    const req = await parseSyncRequest({ endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a1', TOKEN_A, 'above', 0.5)] })
    await syncSubscription(db, req)
    const subId = await subscriptionId(ENDPOINT)
    // The checker claims a1 after the sync has read the old rows but before its write batch.
    const racy: D1Db = {
      prepare: (sql) => db.prepare(sql),
      batch: async (stmts) => {
        expect(await claimAlert(db, subId, 'a1', 0.6, 1234)).toBe(true)
        return db.batch(stmts)
      },
    }
    expect(await syncSubscription(racy, req)).toEqual({ fired: [{ id: 'a1', firedAt: 1234, price: 0.6 }], dropped: [] })
    expect(await db.prepare('SELECT fired_at FROM push_alerts').first()).toEqual({ fired_at: 1234 })
    // Changing the target does re-arm it.
    await syncSubscription(db, await parseSyncRequest({ ...req, alerts: [alert('a1', TOKEN_A, 'above', 0.8)] }))
    expect(await db.prepare('SELECT fired_at FROM push_alerts').first()).toEqual({ fired_at: null })
  })

  it('drops alerts whose token keeps returning no midpoint, and resets on recovery', async () => {
    await syncSubscription(db, await parseSyncRequest({ endpoint: ENDPOINT, keys: sub.keys, alerts: [alert('a1', TOKEN_A, 'above', 0.99), alert('b1', TOKEN_B, 'above', 0.99)] }))
    const at = (i: number) => Date.UTC(2026, 9, 6, 12, 1) + i * 3_600_000 // never minute 0 or a multiple of 10
    for (let i = 0; i < 5; i++) await runCheck(env, { fetcher: mockFetch({ [TOKEN_B]: '0.5' }).fetcher, now: at(i) })
    await runCheck(env, { fetcher: mockFetch({ [TOKEN_A]: '0.5', [TOKEN_B]: '0.5' }).fetcher, now: at(5) })
    expect((await db.prepare('SELECT MAX(misses) AS m FROM push_alerts').first())?.m).toBe(0)
    // A failed CLOB call is not a miss.
    await runCheck(env, { fetcher: (async () => new Response('', { status: 500 })) as typeof fetch, now: at(6) })
    for (let i = 0; i < PUSH_LIMITS.maxMisses; i++) await runCheck(env, { fetcher: mockFetch({ [TOKEN_B]: '0.5' }).fetcher, now: at(7 + i) })
    expect((await db.prepare('SELECT id FROM push_alerts').all()).results).toEqual([{ id: 'b1' }])
  })

  it('buckets IPv6 addresses by /64', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7')
    expect(ipBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('2001:0DB8:0001:0002:ffff:0:0:9')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('::1')).toBe('0:0:0:0::/64')
  })
})
