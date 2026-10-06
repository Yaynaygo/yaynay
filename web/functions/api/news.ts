// Cloudflare Pages Function: GET /api/news?q=<topic>
// Recent headlines about a market from Google News (Bing News as a fallback), cached at the edge.
import { handleNews } from '../../server/news'
import type { CacheLike } from '../../server/lifiProxy'

const edgeCache = (): CacheLike | null =>
  (globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null

export function onRequest({ request }: { request: Request }): Promise<Response> {
  return handleNews(request, { cache: edgeCache() })
}
