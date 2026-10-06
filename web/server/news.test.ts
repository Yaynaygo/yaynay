import { describe, expect, it } from 'vitest'
import { decodeEntities, handleNews, normalizeQuery, parseRss, rankNews, safeUrl, type NewsItem } from './news'
import type { CacheLike } from './lifiProxy'

const GOOGLE = `<?xml version="1.0"?><rss><channel>
<item><title>Fed policymakers lean against October rate hike - Reuters</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Mon, 05 Oct 2026 14:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
<item><title>Traders see little chance of a hike &amp; cut - CNBC</title><link>https://news.google.com/rss/articles/def</link><pubDate>Tue, 06 Oct 2026 09:30:00 GMT</pubDate><source url="https://www.cnbc.com">CNBC</source></item>
<item><title>Broken item</title><link>javascript:alert(1)</link><pubDate>Tue, 06 Oct 2026 09:30:00 GMT</pubDate></item>
</channel></rss>`

const BING = `<rss><channel><item><title>Will the Fed Raise Rates in October?</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2ffinance.yahoo.com%2farticle.html&amp;c=1</link><description>x</description><pubDate>Tue, 06 Oct 2026 21:00:00 GMT</pubDate></item></channel></rss>`

const at = (iso: string) => Date.parse(iso) / 1000

describe('normalizeQuery', () => {
  it('lower-cases, strips symbols and squeezes spaces', () => {
    expect(normalizeQuery('  Fed <script> Rates!!  ')).toBe('fed script rates')
  })
  it('rejects empty and oversized queries', () => {
    expect(normalizeQuery(null)).toBeNull()
    expect(normalizeQuery('a')).toBeNull()
    expect(normalizeQuery('x'.repeat(121))).toBeNull()
  })
})

describe('parseRss', () => {
  it('reads Google News items and drops the publisher suffix', () => {
    const items = parseRss(GOOGLE)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ title: 'Fed policymakers lean against October rate hike', source: 'Reuters', sourceUrl: 'https://www.reuters.com/' })
    expect(items[1].title).toBe('Traders see little chance of a hike & cut')
    expect(items[1].publishedAt).toBe(at('2026-10-06T09:30:00Z'))
  })
  it('unwraps Bing click links and names the source by host', () => {
    const [item] = parseRss(BING)
    expect(item.url).toBe('https://finance.yahoo.com/article.html')
    expect(item.source).toBe('finance.yahoo.com')
  })
  it('trims taglines from publisher names', () => {
    const xml = GOOGLE.replace('>CNBC<', ">Beansprout - Singapore's Leading Platform<").replace(' - CNBC<', " - Beansprout - Singapore's Leading Platform<")
    const items = parseRss(xml)
    expect(items[1].source).toBe('Beansprout')
    expect(items[1].title).toBe('Traders see little chance of a hike & cut')
  })
  it('turns a link used as a publisher name into its host', () => {
    const [, item] = parseRss(GOOGLE.replace('>CNBC<', '>https://www.ingame.de/news<').replace(' - CNBC<', '<'))
    expect(item.source).toBe('ingame.de')
  })
  it('only keeps http(s) links', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeUrl('https://a.com/x')).toBe('https://a.com/x')
  })
  it('decodes entities and CDATA', () => {
    expect(decodeEntities('<![CDATA[A &amp; B]]> &#39;x&#x27;')).toBe("A & B 'x'")
  })
})

describe('rankNews', () => {
  const item = (title: string, publishedAt: number): NewsItem => ({ title, url: 'https://a.com', source: 'A', publishedAt })
  it('sorts newest first and drops near-duplicate headlines', () => {
    const out = rankNews([item('Fed holds rates steady in October', 10), item('Fed holds rates steady in October, again', 20), item('Other story here', 15)], 100)
    expect(out.map((i) => i.publishedAt)).toEqual([20, 15])
  })
  it('drops items dated in the future', () => {
    expect(rankNews([item('From the future story', 10_000)], 100)).toHaveLength(0)
  })
})

describe('handleNews', () => {
  const memoryCache = (): CacheLike & { size: () => number } => {
    const m = new Map<string, Response>()
    return {
      match: async (k) => m.get(String(k))?.clone(),
      put: async (k, r) => void m.set(String(k), r),
      size: () => m.size,
    }
  }
  const req = (q: string, headers: Record<string, string> = {}) => new Request(`https://yaynaygo.xyz/api/news?q=${encodeURIComponent(q)}`, { headers })
  const now = () => Date.parse('2026-10-07T00:00:00Z')

  it('serves Google News and caches by normalized query', async () => {
    const cache = memoryCache()
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response(GOOGLE)
    }) as unknown as typeof fetch
    const a = await handleNews(req('Fed Rates'), { cache, fetcher, now })
    expect(a.status).toBe(200)
    const body = (await a.json()) as { provider: string; items: NewsItem[] }
    expect(body.provider).toBe('google')
    expect(body.items[0].source).toBe('CNBC')
    await handleNews(req('  fed   rates '), { cache, fetcher, now })
    expect(calls).toBe(1)
  })

  it('falls back to Bing when Google fails', async () => {
    const fetcher = (async (url: string) =>
      String(url).includes('google') ? new Response('nope', { status: 503 }) : new Response(BING)) as unknown as typeof fetch
    const res = await handleNews(req('fed'), { cache: null, fetcher, now })
    const body = (await res.json()) as { provider: string; items: NewsItem[] }
    expect(body.provider).toBe('bing')
    expect(body.items).toHaveLength(1)
  })

  it('refuses cross-site requests and bad queries', async () => {
    const fetcher = (async () => new Response(GOOGLE)) as unknown as typeof fetch
    expect((await handleNews(req('fed', { 'Sec-Fetch-Site': 'cross-site' }), { cache: null, fetcher })).status).toBe(403)
    expect((await handleNews(req('x'), { cache: null, fetcher })).status).toBe(400)
  })

  it('reports 502 when every feed fails', async () => {
    const fetcher = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    expect((await handleNews(req('fed'), { cache: null, fetcher })).status).toBe(502)
  })
})
