// GET /api/news?q=<topic>: recent headlines about a market, for the "In the news" card on market pages.
// Google News RSS first, Bing News RSS as a fallback; neither needs a key. Responses are cached at the
// edge per normalized query, so a busy market costs one upstream request every few minutes.
import { json } from './guard.ts'
import type { CacheLike } from './lifiProxy.ts'

export type NewsItem = {
  title: string
  url: string
  source: string
  /** Publisher's home page, when the feed names it. */
  sourceUrl?: string
  /** Unix seconds. */
  publishedAt: number
}

export const NEWS_CACHE_SECONDS = 180
export const NEWS_MAX_ITEMS = 12
const MAX_QUERY = 120

/** Lower-cased, single-spaced query of letters, digits and light punctuation, or null if unusable. */
export function normalizeQuery(raw: string | null): string | null {
  if (!raw) return null
  const q = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s'.&$%-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  if (q.length < 2 || q.length > MAX_QUERY) return null
  return q
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? stripTags(decodeEntities(m[1])) : undefined
}

function attr(xml: string, name: string, attribute: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`, 'i'))
  return m ? decodeEntities(m[1]) : undefined
}

/** Only absolute http(s) links reach the page. */
export function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined
  try {
    const url = new URL(u.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const hostName = (u?: string) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : undefined
  } catch {
    return undefined
  }
}

/** Parses RSS <item>s from Google News or Bing News. */
export function parseRss(xml: string): NewsItem[] {
  const out: NewsItem[] = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1]
    let title = tag(item, 'title') ?? ''
    let url = safeUrl(tag(item, 'link'))
    let source = tag(item, 'source')
    const sourceUrl = safeUrl(attr(item, 'source', 'url'))
    // Bing wraps the article in a click-tracking link; the real address is its url= parameter.
    if (url && /bing\.com\/news\/apiclick/i.test(url)) url = safeUrl(new URL(url).searchParams.get('url') ?? undefined) ?? url
    // Google appends " - Publisher" to every title.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim()
    if (source && /^https?:\/\//i.test(source)) source = hostName(source) ?? source
    if (!source) source = hostName(sourceUrl) ?? hostName(url) ?? 'News'
    // Some publishers put a tagline in their name: "Beansprout - Singapore's Leading Financial …".
    source = source.split(/\s[-|–—]\s/)[0].trim().slice(0, 40)
    const published = Date.parse(tag(item, 'pubDate') ?? '')
    if (!title || !url || !Number.isFinite(published)) continue
    out.push({ title, url, source, sourceUrl, publishedAt: Math.floor(published / 1000) })
  }
  return out
}

const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter((w) => w.length > 2)
    .slice(0, 5)
    .join(' ')

/** Newest first, one story per near-identical headline, capped. */
export function rankNews(items: NewsItem[], nowSec: number, max = NEWS_MAX_ITEMS): NewsItem[] {
  const seen = new Set<string>()
  return items
    .filter((i) => i.publishedAt <= nowSec + 600)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .filter((i) => {
      const k = titleKey(i.title)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, max)
}

export const googleNewsUrl = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&hl=en-US&gl=US&ceid=US:en`
export const bingNewsUrl = (q: string) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=en`

async function fetchFeed(url: string, fetcher: typeof fetch): Promise<NewsItem[]> {
  const res = await fetcher(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YayNay/1.0; +https://yaynaygo.xyz)', Accept: 'application/rss+xml, application/xml, text/xml' },
  })
  if (!res.ok) throw new Error(`feed ${res.status}`)
  return parseRss(await res.text())
}

export async function handleNews(
  request: Request,
  opts: { cache: CacheLike | null; fetcher?: typeof fetch; now?: () => number },
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)
  const site = request.headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin') return json({ error: 'cross-site request refused' }, 403)

  const q = normalizeQuery(new URL(request.url).searchParams.get('q'))
  if (!q) return json({ error: 'q must be 2–120 characters' }, 400)

  const cacheKey = `https://news-cache.yaynay.internal/v1?q=${encodeURIComponent(q)}`
  const hit = await opts.cache?.match(cacheKey)
  if (hit) return hit

  const fetcher = opts.fetcher ?? fetch
  const now = Math.floor((opts.now ?? Date.now)() / 1000)
  let items: NewsItem[] = []
  let provider = 'google'
  try {
    items = await fetchFeed(googleNewsUrl(q), fetcher)
  } catch {
    items = []
  }
  if (items.length === 0) {
    provider = 'bing'
    try {
      items = await fetchFeed(bingNewsUrl(q), fetcher)
    } catch {
      return json({ error: 'news unavailable' }, 502)
    }
  }

  const res = json({ query: q, provider, fetchedAt: now, items: rankNews(items, now) }, 200, {
    'Cache-Control': `public, max-age=${NEWS_CACHE_SECONDS}`,
  })
  await opts.cache?.put(cacheKey, res.clone())
  return res
}
