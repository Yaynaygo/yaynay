// Cloudflare Pages Function: POST /api/push/unsubscribe
// Deletes a push subscription and every alert stored for it. Body: { endpoint }
// Not rate-limited: deleting your own data should always work.
import { json, originError } from '../../../server/guard'
import { deleteSubscription, parseUnsubscribeRequest, PushError, type D1Db } from '../../../server/pushStore'

type Env = { ALLOWED_ORIGINS?: string; DB?: D1Db }

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const refused = originError(request, env.ALLOWED_ORIGINS)
  if (refused) return json({ error: refused }, 403)
  if (!env.DB) return json({ error: 'push alerts are not configured' }, 404)

  try {
    const raw = await request.text()
    if (raw.length > 4096) return json({ error: 'body too large' }, 413)
    const { endpoint } = parseUnsubscribeRequest(JSON.parse(raw))
    return json({ ok: true, deleted: await deleteSubscription(env.DB, endpoint) })
  } catch (e) {
    if (e instanceof PushError) return json({ error: e.message }, e.status)
    if (e instanceof SyntaxError) return json({ error: 'invalid JSON' }, 400)
    console.error('[push/unsubscribe]', e)
    return json({ error: 'could not delete alerts' }, 500)
  }
}
