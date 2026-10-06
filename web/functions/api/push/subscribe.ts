// Cloudflare Pages Function: POST /api/push/subscribe
// Upserts a push subscription and replaces its set of armed price alerts.
// Body: { endpoint, keys: { p256dh, auth }, alerts: [{ id, tokenId, op, price, title, slug, outcome }] }
import { json, originError } from '../../../server/guard'
import { clobKnownTokens, countPushCall, parseSyncRequest, PushError, syncSubscription, type D1Db } from '../../../server/pushStore'

type Env = { ALLOWED_ORIGINS?: string; DB?: D1Db; VAPID_PUBLIC_KEY?: string; SESSION_SECRET?: string }

const MAX_BODY = 64 * 1024

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const refused = originError(request, env.ALLOWED_ORIGINS)
  if (refused) return json({ error: refused }, 403)
  if (!env.DB || !env.VAPID_PUBLIC_KEY) return json({ error: 'push alerts are not configured' }, 404)

  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY) return json({ error: 'body too large' }, 413)
    const req = await parseSyncRequest(JSON.parse(raw))
    const salt = env.SESSION_SECRET ?? env.VAPID_PUBLIC_KEY
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    if (!(await countPushCall(env.DB, ip, salt))) {
      return json({ error: 'too many alert updates from your network today' }, 429)
    }
    // Per-IP budgets for new subscriptions and new alerts; unknown CLOB tokens are dropped.
    return json({ ok: true, ...(await syncSubscription(env.DB, req, { client: { ip, salt }, knownTokens: clobKnownTokens() })) })
  } catch (e) {
    if (e instanceof PushError) return json({ error: e.message }, e.status)
    if (e instanceof SyntaxError) return json({ error: 'invalid JSON' }, 400)
    console.error('[push/subscribe]', e)
    return json({ error: 'could not save alerts' }, 500)
  }
}
