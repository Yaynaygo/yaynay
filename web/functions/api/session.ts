// Cloudflare Pages Function: POST /api/session
// Exchanges a Turnstile token for the HttpOnly session cookie the builder signer requires.
import { createSessionCookie, verifyTurnstile, type SessionEnv } from '../../server/session'
import { json, originError } from '../../server/guard'

type Env = SessionEnv & { ALLOWED_ORIGINS?: string }

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const refused = originError(request, env.ALLOWED_ORIGINS)
  if (refused) return json({ error: refused }, 403)
  if (!env.SESSION_SECRET || !env.TURNSTILE_SECRET_KEY) return json({ error: 'server is not configured' }, 500)

  const { token } = ((await request.json().catch(() => ({}))) ?? {}) as { token?: unknown }
  if (typeof token !== 'string' || token.length === 0) return json({ error: 'token required' }, 400)

  const ok = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, request.headers.get('CF-Connecting-IP'))
  if (!ok) return json({ error: 'verification failed' }, 403)

  const { cookie, expiresAt } = await createSessionCookie(env.SESSION_SECRET)
  return json({ expiresAt }, 200, { 'Set-Cookie': cookie })
}
