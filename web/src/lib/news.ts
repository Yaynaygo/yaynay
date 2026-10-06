// Headlines for a market's "In the news" card, through our cached /api/news endpoint.

export type NewsItem = {
  title: string
  url: string
  source: string
  sourceUrl?: string
  /** Unix seconds. */
  publishedAt: number
}

export type NewsResult = { query: string; provider: string; fetchedAt: number; items: NewsItem[] }

/** How often an open market page asks for fresh headlines (the edge caches for 3 minutes). */
export const NEWS_REFRESH_MS = 3 * 60 * 1000

const STOP = new Set(
  (
    'will the be a an of in on at to for by from after before there is are was were does do did who what which when how ' +
    'many much or and if this that with than any its his her their next win wins winner won reach hit above below ' +
    'between end out up down over under than more less most least happen announce announced say says'
  ).split(' '),
)

const words = (s: string) =>
  s
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ') // ISO dates: too specific for a news search
    .replace(/[^\p{L}\p{N}\s.&'-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter(Boolean)

/**
 * A short news search for an event title: "Counter-Strike: Team Falcons vs Natus Vincere (BO3) - ESL…"
 * becomes "team falcons vs natus vincere", "Will Benjamin Netanyahu be the next Prime Minister of Israel?"
 * becomes "benjamin netanyahu prime minister israel".
 */
export function newsQuery(title: string, maxWords = 6): string {
  const clean = title.replace(/\([^)]*\)/g, ' ').replace(/[?!]/g, ' ')
  const parts = clean.split(/\s+[-–—·|]\s+|:\s+/).map((p) => p.trim()).filter(Boolean)
  // A matchup reads best as just the two sides.
  const matchup = parts.find((p) => /\s(vs\.?|v\.?)\s/i.test(p))
  if (matchup) {
    return words(matchup)
      .map((w) => (/^v\.?$|^vs\.?$/i.test(w) ? 'vs' : w))
      .join(' ')
      .toLowerCase()
  }
  const kept = words(parts.join(' ')).filter((w) => !STOP.has(w.toLowerCase()))
  return kept.slice(0, maxWords).join(' ').toLowerCase()
}

export async function fetchNews(query: string, signal?: AbortSignal): Promise<NewsResult> {
  const res = await fetch(`/api/news?q=${encodeURIComponent(query)}`, { signal })
  if (!res.ok) throw new Error(`News unavailable: ${res.status}`)
  return (await res.json()) as NewsResult
}

/** "Reuters" → "R", "finance.yahoo.com" → "Y", "The Wall Street Journal" → "W". */
export function monogram(source: string): string {
  const host = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(source) ? source.split('.').slice(-2, -1)[0] : source
  const word = host.replace(/^the\s+/i, '').trim()
  return (word[0] ?? '•').toUpperCase()
}

// ---------- headlines paired with markets (home page corner) ----------

type EventLike = {
  slug: string
  title: string
  image?: string
  markets: { label: string; outcomes: { name: string; price: number }[] }[]
}

export type MarketHeadline = NewsItem & {
  event: { slug: string; title: string; image?: string }
  /** The event's leading outcome and its chance, 0–1. */
  odds: { label: string; chance: number } | null
}

/** "Yes 62%" for a single market, else the outcome the crowd favours most ("Le Pen 43%"). */
export function leadingOdds(e: EventLike): { label: string; chance: number } | null {
  const priced = e.markets.filter((m) => m.outcomes.length > 0 && Number.isFinite(m.outcomes[0].price))
  if (priced.length === 0) return null
  if (priced.length === 1) return { label: priced[0].outcomes[0].name, chance: priced[0].outcomes[0].price }
  const best = priced.reduce((a, b) => (b.outcomes[0].price > a.outcomes[0].price ? b : a))
  return { label: best.label || best.outcomes[0].name, chance: best.outcomes[0].price }
}

/**
 * Takes the newest `perEvent` stories for each event, then interleaves events round-robin so one busy
 * story can't fill the whole rotation. Duplicate article links keep their first pairing.
 */
export function pairHeadlines(groups: { event: EventLike; items: NewsItem[] }[], perEvent = 2, max = 10): MarketHeadline[] {
  const seen = new Set<string>()
  const lanes = groups.map((g) => {
    const lane: MarketHeadline[] = []
    for (const i of g.items) {
      if (lane.length >= perEvent) break
      if (seen.has(i.url)) continue
      seen.add(i.url)
      lane.push({ ...i, event: { slug: g.event.slug, title: g.event.title, image: g.event.image }, odds: leadingOdds(g.event) })
    }
    return lane
  })
  const out: MarketHeadline[] = []
  for (let round = 0; round < perEvent; round++) for (const lane of lanes) if (lane[round]) out.push(lane[round])
  return out.slice(0, max)
}

// ---------- odds move since a story (market cards) ----------

/**
 * How far the price moved since `t`, in probability points (0.04 = +4 pts): the last price now minus the
 * price at the story's time. Null when the history doesn't reach back to the story or is too thin.
 */
export function moveSince(history: { t: number; p: number }[], t: number): number | null {
  if (history.length < 2) return null
  if (t < history[0].t) return null
  let before = history[0]
  for (const pt of history) {
    if (pt.t > t) break
    before = pt
  }
  return history[history.length - 1].p - before.p
}

/** Publisher favicon, from the feed's source link (Google News article links are redirects, so not those). */
export function faviconUrl(item: NewsItem): string | undefined {
  if (!item.sourceUrl) return undefined
  try {
    const host = new URL(item.sourceUrl).hostname
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
  } catch {
    return undefined
  }
}

/** Words that say nothing about a story on their own. */
const GENERIC = new Set('2024 2025 2026 2027 2028 2029 2030 january february march april june july august september october november december winner champion election price market league cup season game games match team series world final'.split(' '))

/**
 * Keeps stories whose headline names at least one distinctive word of the query (4+ letters, allowing a
 * short ending such as a plural), so a search for "elon musk tweets october" doesn't surface a SpaceX story with neither name in it.
 */
export function relevant<T extends { title: string }>(items: T[], query: string): T[] {
  const keys = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !GENERIC.has(w) && w !== 'vs')
  if (keys.length === 0) return items
  return items.filter((i) => {
    const words = i.title.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    // Same word, or a short ending like a plural ("tariff" → "tariffs"), not a longer word ("champions" ≠ "championship").
    return keys.some((k) => words.some((w) => w === k || (w.startsWith(k) && w.length - k.length <= 2) || (k.startsWith(w) && w.length >= 4 && k.length - w.length <= 1)))
  })
}
