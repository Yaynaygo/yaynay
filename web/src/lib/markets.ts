import { tradingIds, type ProtocolVersion } from './protocol'
import { CLOB_API, DATA_API, DECIDED_PRICE, GAMMA_API, RECURRING_ROUND_RE } from '../config'

export type Outcome = { name: string; tokenId: string; price: number }

export type Market = {
  id: string
  /** Polymarket protocol version; V2 markets trade V2 position IDs (in `outcomes[].tokenId`). */
  version: ProtocolVersion
  question: string
  label: string
  conditionId: string
  outcomes: Outcome[]
  minSize: number
  tickSize: number
  negRisk: boolean
  description: string
  resolutionSource: string
  endDate?: string
  /** Change of the first outcome's price over 24h, in probability points (e.g. 0.03 = +3pp). */
  dayChange: number
  volume: number
}

export type PmEvent = {
  id: string
  title: string
  slug: string
  image?: string
  volume24hr: number
  liquidity: number
  /** All-time volume. */
  volume: number
  startDate?: string
  endDate?: string
  description: string
  tags: { slug: string; label: string }[]
  commentCount: number
  markets: Market[]
}

type RawMarket = {
  id: string
  question: string
  groupItemTitle?: string
  conditionId: string
  clobTokenIds?: string
  /** Protocol V2 position IDs, used instead of clobTokenIds when `version` is "v2". */
  positionIds?: string | string[]
  version?: string
  outcomes?: string
  outcomePrices?: string
  active?: boolean
  closed?: boolean
  acceptingOrders?: boolean
  orderMinSize?: number
  orderPriceMinTickSize?: number
  negRisk?: boolean
  description?: string
  resolutionSource?: string
  endDate?: string
  oneDayPriceChange?: number | string
  volumeNum?: number
  volume?: number | string
}

type RawEvent = {
  id: string
  title: string
  slug: string
  image?: string
  volume24hr?: number
  liquidity?: number | string
  volume?: number | string
  startDate?: string
  endDate?: string
  description?: string
  resolutionSource?: string
  tags?: { slug: string; label: string }[]
  commentCount?: number
  negRisk?: boolean
  markets?: RawMarket[]
}

function parseList(json: string | undefined): string[] {
  try {
    return json ? (JSON.parse(json) as string[]) : []
  } catch {
    return []
  }
}

function toMarket(m: RawMarket): Market | null {
  if (!m.active || m.closed || !m.acceptingOrders) return null
  const names = parseList(m.outcomes)
  // `tokenId` holds whatever ID this market trades under: the CTF token (V1) or the V2 position ID.
  const { version, ids: tokens } = tradingIds(m)
  const prices = parseList(m.outcomePrices).map(Number)
  // Polymarket markets are binary; anything else is malformed for our UI.
  if (names.length < 2 || names.length !== tokens.length) return null
  return {
    id: m.id,
    version,
    question: m.question,
    label: m.groupItemTitle || m.question,
    conditionId: m.conditionId,
    outcomes: names.map((name, i) => ({ name, tokenId: tokens[i], price: prices[i] ?? 0 })),
    minSize: m.orderMinSize ?? 5,
    tickSize: m.orderPriceMinTickSize ?? 0.01,
    negRisk: !!m.negRisk,
    description: m.description ?? '',
    resolutionSource: m.resolutionSource ?? '',
    endDate: m.endDate,
    dayChange: Number(m.oneDayPriceChange ?? 0) || 0,
    volume: Number(m.volumeNum ?? m.volume ?? 0) || 0,
  }
}

// Prices this close to 0 or 1 mean the outcome is effectively decided (often a finished game
// awaiting resolution); they are noise in a market list and a trap for buyers ("risk 97¢ to make 3¢").
const DECIDED = DECIDED_PRICE

function toEvent(e: RawEvent): PmEvent | null {
  let markets = (e.markets ?? []).map(toMarket).filter((m): m is Market => m !== null)
  const decided = (m: Market) => m.outcomes.some((o) => o.price >= DECIDED)
  if (markets.length === 1) {
    if (decided(markets[0])) return null
  } else {
    // Mutually exclusive outcomes: one at 97¢+ means the whole event is effectively decided.
    if (e.negRisk && markets.some((m) => (m.outcomes[0]?.price ?? 0) >= DECIDED)) return null
    // In multi-outcome events a 0% runner-up is normal; drop only sub-markets already decided "Yes".
    markets = markets.filter((m) => (m.outcomes[0]?.price ?? 0) < DECIDED)
    // Every remaining option near 0%: the winner was decided (and closed) elsewhere.
    if (markets.every((m) => (m.outcomes[0]?.price ?? 0) < 0.02)) return null
  }
  if (markets.length === 0) return null
  // Events often carry the shared rules; fall back to them for sub-markets without their own.
  markets = markets.map((m) => ({
    ...m,
    description: m.description || e.description || '',
    resolutionSource: m.resolutionSource || e.resolutionSource || '',
    endDate: m.endDate ?? e.endDate,
  }))
  return {
    id: e.id,
    title: e.title,
    slug: e.slug,
    image: e.image,
    volume24hr: e.volume24hr ?? 0,
    liquidity: Number(e.liquidity ?? 0) || 0,
    volume: Number(e.volume ?? 0) || 0,
    startDate: e.startDate,
    endDate: e.endDate,
    description: e.description ?? '',
    tags: (e.tags ?? []).filter((t) => t?.slug && t.label),
    commentCount: e.commentCount ?? 0,
    markets,
  }
}

// Events seen in lists, so a market page can render instantly and refresh in the background.
const eventCache = new Map<string, PmEvent>()
const remember = (events: PmEvent[]) => {
  for (const e of events) eventCache.set(e.slug, e)
  return events
}
export const peekEvent = (slug: string) => eventCache.get(slug)

export const CATEGORIES = [
  { slug: '', label: 'Trending' },
  { slug: 'politics', label: 'Politics' },
  { slug: 'crypto', label: 'Crypto' },
  { slug: 'sports', label: 'Sports' },
  { slug: 'economy', label: 'Economy' },
  { slug: 'tech', label: 'Tech' },
] as const

export type SortKey = 'trending' | 'ending' | 'liquid' | 'new'

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'trending', label: '24h volume' },
  { key: 'ending', label: 'Ending soon' },
  { key: 'liquid', label: 'Most liquid' },
  { key: 'new', label: 'Newest' },
]

// Recurring 5-minute/hourly crypto "Up or Down" rounds flood the "ending soon" and "new" lists.
const isRecurringRound = (e: PmEvent) => RECURRING_ROUND_RE.test(e.title)

export async function listTrendingEvents(tag = '', sort: SortKey = 'trending', limit = 30): Promise<PmEvent[]> {
  const params = listParams(tag, sort)
  params.set('limit', String(limit * 2))
  const res = await fetch(`${GAMMA_API}/events?${params}`)
  if (!res.ok) throw new Error(`Gamma events failed: ${res.status}`)
  let events = ((await res.json()) as RawEvent[]).map(toEvent).filter((e): e is PmEvent => e !== null)
  if (sort === 'ending' || sort === 'new') events = events.filter((e) => !isRecurringRound(e))
  return remember(events.slice(0, limit))
}

/** Markets per page in the list. Gamma counts every listed event, so a page can show a few fewer after filtering. */
export const PAGE_SIZE = 48

export type EventsPage = { events: PmEvent[]; total: number }

function listParams(tag: string, sort: SortKey) {
  const params = new URLSearchParams({ active: 'true', closed: 'false', archived: 'false' })
  if (tag) params.set('tag_slug', tag)
  if (sort === 'trending') params.set('order', 'volume24hr')
  if (sort === 'liquid') params.set('order', 'liquidity')
  if (sort === 'new') params.set('order', 'startDate')
  if (sort === 'ending') {
    params.set('order', 'endDate')
    params.set('ascending', 'true')
    params.set('end_date_min', new Date(Date.now() + 60 * 60_000).toISOString())
  } else {
    params.set('ascending', 'false')
  }
  return params
}

/** One numbered page (0-based) of open events, with the total count for the pager. */
export async function listEventsPage(tag: string, sort: SortKey, page: number): Promise<EventsPage> {
  const params = listParams(tag, sort)
  params.set('limit', String(PAGE_SIZE))
  params.set('offset', String(page * PAGE_SIZE))
  const res = await fetch(`${GAMMA_API}/events/pagination?${params}`)
  if (!res.ok) throw new Error(`Gamma events failed: ${res.status}`)
  const body = (await res.json()) as { data?: RawEvent[]; pagination?: { totalResults?: number } }
  let events = (body.data ?? []).map(toEvent).filter((e): e is PmEvent => e !== null)
  if (sort === 'ending' || sort === 'new') events = events.filter((e) => !isRecurringRound(e))
  return { events: remember(events), total: body.pagination?.totalResults ?? events.length }
}

/** One numbered page (0-based) of search results. */
export async function searchEventsPage(query: string, page: number): Promise<EventsPage> {
  const url = `${GAMMA_API}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${PAGE_SIZE}&page=${page + 1}&events_status=active`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Gamma search failed: ${res.status}`)
  const body = (await res.json()) as { events?: RawEvent[]; pagination?: { totalResults?: number } }
  const events = (body.events ?? []).map(toEvent).filter((e): e is PmEvent => e !== null)
  return { events: remember(events), total: body.pagination?.totalResults ?? events.length }
}

/** One event by its slug, for shareable market links. Returns null if it is closed or unknown. */
export async function fetchEventBySlug(slug: string): Promise<PmEvent | null> {
  const res = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`)
  if (!res.ok) throw new Error(`Gamma event failed: ${res.status}`)
  const [raw] = (await res.json()) as RawEvent[]
  return raw ? toEvent(raw) : null
}

export type EventPage =
  | { status: 'open'; event: PmEvent }
  | { status: 'closed'; title: string; slug: string; image?: string }
  | { status: 'missing' }

/** An event for its own page: open, closed (resolved or settled), or unknown. */
export async function fetchEventPage(slug: string): Promise<EventPage> {
  const res = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`)
  if (!res.ok) throw new Error(`Gamma event failed: ${res.status}`)
  const [raw] = (await res.json()) as RawEvent[]
  if (!raw) return { status: 'missing' }
  const event = toEvent(raw)
  if (event) remember([event])
  return event ? { status: 'open', event } : { status: 'closed', title: raw.title, slug: raw.slug, image: raw.image }
}

/** Events by slug (the watchlist), 50 per request. Closed ones are dropped. */
export async function fetchEventsBySlugs(slugs: string[]): Promise<PmEvent[]> {
  const chunks: string[][] = []
  for (let i = 0; i < slugs.length; i += 50) chunks.push(slugs.slice(i, i + 50))
  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      // Gamma returns 20 events unless told otherwise.
      const params = new URLSearchParams({ limit: String(chunk.length) })
      for (const slug of chunk) params.append('slug', slug)
      const res = await fetch(`${GAMMA_API}/events?${params}`)
      if (!res.ok) throw new Error(`Gamma events failed: ${res.status}`)
      return (await res.json()) as RawEvent[]
    }),
  )
  const events = pages.flat().map(toEvent).filter((e): e is PmEvent => e !== null)
  // Keep the user's order (most recently watched first).
  const order = new Map(slugs.map((s, i) => [s, i]))
  return remember(events.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0)))
}

export async function searchEvents(query: string): Promise<PmEvent[]> {
  const url = `${GAMMA_API}/public-search?q=${encodeURIComponent(query)}&limit_per_type=20&events_status=active`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Gamma search failed: ${res.status}`)
  const body = (await res.json()) as { events?: RawEvent[] }
  return remember((body.events ?? []).map(toEvent).filter((e): e is PmEvent => e !== null))
}

export type Position = {
  asset: string
  conditionId: string
  title: string
  outcome: string
  size: number
  avgPrice: number
  curPrice: number
  currentValue: number
  cashPnl: number
  redeemable: boolean
  negativeRisk: boolean
  /** Event page slug, for linking a position to its market page. */
  eventSlug?: string
}

type V2Position = {
  token_id: string
  condition_id: string
  title: string
  outcome: string
  current_size: number
  avg_price: number
  current_price: number
  current_value: number
  unrealized_pnl: number
  redeemable: boolean
  negative_risk: boolean
  event_slug?: string
}

async function fetchPositionsV2(wallet: string, status: 'OPEN' | 'REDEEMABLE'): Promise<Position[]> {
  const res = await fetch(`${DATA_API}/v2/positions?user=${wallet}&status=${status}&limit=100`)
  if (!res.ok) throw new Error(`Data API positions failed: ${res.status}`)
  const body = (await res.json()) as { data?: V2Position[] | null }
  return (body.data ?? []).map((p) => ({
    asset: p.token_id,
    conditionId: p.condition_id,
    title: p.title,
    outcome: p.outcome,
    size: p.current_size,
    avgPrice: p.avg_price,
    curPrice: p.current_price,
    currentValue: p.current_value,
    cashPnl: p.unrealized_pnl,
    redeemable: p.redeemable,
    negativeRisk: p.negative_risk,
    eventSlug: p.event_slug || undefined,
  }))
}

/** Open and redeemable (won) positions; Data API v2 (v1 is retired on 2026-10-24). */
export async function listPositions(wallet: string): Promise<Position[]> {
  const [open, redeemable] = await Promise.all([
    fetchPositionsV2(wallet, 'OPEN'),
    fetchPositionsV2(wallet, 'REDEEMABLE'),
  ])
  const seen = new Set(redeemable.map((p) => p.asset))
  return [...redeemable, ...open.filter((p) => !seen.has(p.asset))].filter((p) => p.size >= 0.01)
}

export type BookTop = { bestBid: number | null; bestAsk: number | null; tickSize: number; minSize: number }

/** Top of the CLOB order book for one outcome token (public endpoint). */
export async function fetchBookTop(tokenId: string): Promise<BookTop> {
  const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`)
  if (!res.ok) throw new Error(`Order book unavailable: ${res.status}`)
  const book = (await res.json()) as {
    bids?: { price: string }[]
    asks?: { price: string }[]
    tick_size?: string
    min_order_size?: string
  }
  const bids = (book.bids ?? []).map((b) => Number(b.price))
  const asks = (book.asks ?? []).map((a) => Number(a.price))
  return {
    bestBid: bids.length ? Math.max(...bids) : null,
    bestAsk: asks.length ? Math.min(...asks) : null,
    tickSize: Number(book.tick_size ?? 0.01),
    minSize: Number(book.min_order_size ?? 5),
  }
}

export function roundToTick(value: number, tick: number): string {
  const decimals = Math.max(0, Math.round(-Math.log10(tick)))
  return (Math.round(value / tick) * tick).toFixed(decimals)
}
