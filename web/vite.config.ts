import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { parseSignRequest, signBuilderRequest, SignError } from './server/builderSign.ts'
import { LIFI_UPSTREAM, quoteQuery } from './server/lifiProxy.ts'

// Dev-only stand-ins for the Cloudflare Pages Functions in functions/api. They apply the same
// request validation; Turnstile and the D1 daily limits only run on Cloudflare.
function devApi(env: Record<string, string>): Plugin {
  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        const send = (status: number, body: unknown) => {
          res.statusCode = status
          res.end(JSON.stringify(body))
        }
        const origin = req.headers.origin
        const host = req.headers.host
        if (req.method !== 'POST' || !origin || !host || new URL(origin).host !== host) {
          return send(403, { error: 'origin not allowed' })
        }
        if (req.url === '/session') return send(200, { expiresAt: Math.floor(Date.now() / 1000) + 12 * 3600 })
        if (req.url === '/lifi/quote') {
          // Same validation as functions/api/lifi/quote.ts; no session or daily caps in dev.
          if (!env.LIFI_API_KEY) return send(404, { message: 'not configured' })
          let body = ''
          for await (const chunk of req) body += chunk
          const fields = Object.entries((JSON.parse(body || '{}') as Record<string, unknown>) ?? {})
          const query = quoteQuery(new URLSearchParams(fields.map(([k, v]): [string, string] => [k, String(v)])))
          if (!query) return send(400, { message: 'bad request' })
          const upstream = await fetch(`${LIFI_UPSTREAM}?${query}`, { headers: { 'x-lifi-api-key': env.LIFI_API_KEY } })
          res.statusCode = upstream.ok ? 200 : upstream.status === 404 ? 422 : upstream.status
          return res.end(await upstream.text())
        }
        if (req.url !== '/builder/sign') return send(404, { error: 'not found' })

        let raw = ''
        for await (const chunk of req) raw += chunk
        try {
          send(200, await signBuilderRequest(parseSignRequest(JSON.parse(raw || '{}')), env))
        } catch (e) {
          server.config.logger.warn(`[builder-sign] ${e instanceof Error ? e.message : e}`)
          send(e instanceof SignError ? e.status : 400, { error: e instanceof Error ? e.message : 'bad request' })
        }
      })
    },
  }
}

// Dev-only stand-in for functions/api/push/* and the push-worker cron, on an in-memory SQLite D1.
// Needs VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env.local (node scripts/vapid.mjs). Extra routes:
// POST /api/push/test sends a test push to every dev subscription; POST /api/push/check runs one cron pass.
function devPushApi(env: Record<string, string>): Plugin {
  return {
    name: 'dev-push-api',
    configureServer(server) {
      let db: Promise<import('./server/pushStore.ts').D1Db> | undefined
      server.middlewares.use('/api/push', async (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        const send = (status: number, body: unknown) => {
          res.statusCode = status
          res.end(JSON.stringify(body))
        }
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return send(404, { error: 'push alerts are not configured' })
        if (req.method === 'GET' && req.url === '/key') return send(200, { key: env.VAPID_PUBLIC_KEY })
        const origin = req.headers.origin
        const host = req.headers.host
        if (req.method !== 'POST' || !origin || !host || new URL(origin).host !== host) return send(403, { error: 'origin not allowed' })

        const store = await import('./server/pushStore.ts')
        const worker = await import('./push-worker/src/index.ts')
        db ??= import('./push-worker/src/sqliteD1.ts').then((m) => m.sqliteD1())
        const d1 = await db
        const workerEnv = { DB: d1, VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY, VAPID_SUBJECT: env.VAPID_SUBJECT || 'http://localhost:5173' }
        let raw = ''
        for await (const chunk of req) raw += chunk
        try {
          if (req.url === '/subscribe') return send(200, { ok: true, ...(await store.syncSubscription(d1, await store.parseSyncRequest(JSON.parse(raw || '{}')), { knownTokens: store.clobKnownTokens() })) })
          if (req.url === '/unsubscribe') {
            const { endpoint } = store.parseUnsubscribeRequest(JSON.parse(raw || '{}'))
            return send(200, { ok: true, deleted: await store.deleteSubscription(d1, endpoint) })
          }
          if (req.url === '/check') return send(200, await worker.runCheck(workerEnv, { log: (m) => server.config.logger.info(m) }))
          if (req.url === '/test') {
            const { sendPush } = await import('./server/webpush.ts')
            const rows = (await d1.prepare('SELECT id FROM push_subs').all<{ id: string }>()).results
            const subs = await store.loadSubscriptions(d1, rows.map((r) => r.id))
            const vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: workerEnv.VAPID_SUBJECT }
            const results = []
            for (const sub of subs.values()) {
              const r = await sendPush(sub, { title: 'YayNay test push', body: 'Web Push works end to end.', url: '/#/', tag: 'yaynay-test' }, vapid)
              results.push({ host: new URL(sub.endpoint).host, status: r.status })
            }
            return send(200, { results })
          }
          return send(404, { error: 'not found' })
        } catch (e) {
          server.config.logger.warn(`[push] ${e instanceof Error ? e.message : e}`)
          send(e instanceof store.PushError ? e.status : 400, { error: e instanceof Error ? e.message : 'bad request' })
        }
      })
    },
  }
}

// Cloudflare Pages exposes the deployed commit; locally fall back to git, then to "dev".
function gitCommit(): string {
  if (process.env.CF_PAGES_COMMIT_SHA) return process.env.CF_PAGES_COMMIT_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (command === 'build' && mode === 'production') {
    // A missing builder code would silently strip attribution from every order.
    if (!/^0x[0-9a-fA-F]{64}$/.test(env.VITE_BUILDER_CODE ?? '')) {
      throw new Error('VITE_BUILDER_CODE must be set to the 0x-prefixed bytes32 builder code for production builds')
    }
    if (!env.VITE_TURNSTILE_SITE_KEY) throw new Error('VITE_TURNSTILE_SITE_KEY must be set for production builds')
  }
  const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version
  return {
    // devPushApi first: it owns /api/push/* (including GET /key) before devApi's POST-only handler.
    plugins: [react(), devPushApi(env), devApi(env)],
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __APP_COMMIT__: JSON.stringify(gitCommit()),
    },
  }
})
