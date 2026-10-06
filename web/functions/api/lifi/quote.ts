// Cloudflare Pages Function: POST /api/lifi/quote
// Top-up quotes through our LI.FI API key, used only after a user's network hits LI.FI's anonymous limit.
import { handleLifiQuote, type CacheLike, type LifiEnv } from '../../../server/lifiProxy'

const edgeCache = (): CacheLike | null =>
  (globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null

export function onRequest({ request, env }: { request: Request; env: LifiEnv }): Promise<Response> {
  return handleLifiQuote(request, env, { cache: edgeCache() })
}
