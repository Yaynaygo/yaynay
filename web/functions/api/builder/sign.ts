// Cloudflare Pages Function: POST /api/builder/sign
// Signs Polymarket relayer/CLOB requests with our builder credentials for our own page only.
import { parseSignRequest, signBuilderRequest, SignError, type BuilderEnv } from '../../../server/builderSign'
import { hasValidSession, type SessionEnv } from '../../../server/session'
import { countAndCheck, type D1Like } from '../../../server/limits'
import { json, originError } from '../../../server/guard'

type Env = BuilderEnv &
  SessionEnv & {
    ALLOWED_ORIGINS?: string
    DB?: D1Like
    /** Set to "1" only for previews without D1; production must have the DB binding. */
    ALLOW_NO_LIMITS?: string
  }

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const refused = originError(request, env.ALLOWED_ORIGINS)
  if (refused) return json({ error: refused }, 403)

  if (!env.SESSION_SECRET) return json({ error: 'server is not configured' }, 500)
  if (!(await hasValidSession(request.headers.get('Cookie'), env.SESSION_SECRET))) {
    return json({ error: 'session required' }, 401)
  }

  try {
    const req = parseSignRequest(await request.json())
    if (req.isWrite) {
      if (env.DB) {
        const check = await countAndCheck(env.DB, {
          ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
          isRelayer: req.isRelayerTx,
          wallet: req.relayerFrom,
          salt: env.SESSION_SECRET,
        })
        if (!check.ok) return json({ error: check.reason }, 429)
      } else if (env.ALLOW_NO_LIMITS !== '1') {
        return json({ error: 'server is not configured' }, 500)
      }
    }
    return json(await signBuilderRequest(req, env))
  } catch (e) {
    const status = e instanceof SignError ? e.status : 400
    return json({ error: e instanceof Error ? e.message : 'bad request' }, status)
  }
}
