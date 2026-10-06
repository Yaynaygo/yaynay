// Cloudflare Pages Function: POST /api/nansen/<allowlisted path>
// Forwards a few Nansen Prediction Market calls with our server-side API key, cached for 5 minutes.
import { handleNansen, type CacheLike, type NansenEnv } from '../../../server/nansen'

// Cloudflare's default cache; not in the Node typings this folder is checked against.
const edgeCache = (): CacheLike | null =>
  (globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null

export function onRequest({ request, env, params }: { request: Request; env: NansenEnv; params: { path?: string[] | string } }): Promise<Response> {
  return handleNansen(request, env, params.path, { cache: edgeCache() })
}
