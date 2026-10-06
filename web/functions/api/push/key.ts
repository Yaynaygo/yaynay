// Cloudflare Pages Function: GET /api/push/key
// The VAPID public key browsers subscribe with. 404 hides the "alerts when closed" feature.
import { json } from '../../../server/guard'
import type { D1Db } from '../../../server/pushStore'

type Env = { VAPID_PUBLIC_KEY?: string; DB?: D1Db }

export async function onRequestGet({ env }: { env: Env }): Promise<Response> {
  if (!env.VAPID_PUBLIC_KEY || !env.DB) return json({ error: 'push alerts are not configured' }, 404)
  return json({ key: env.VAPID_PUBLIC_KEY }, 200, { 'Cache-Control': 'public, max-age=300' })
}
