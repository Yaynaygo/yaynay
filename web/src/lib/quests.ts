import type { ProgressEvent } from './progress'
import { routeHref } from './router'

// Quests reward learning, safety habits and exploring. Responsible by design: no quest scales
// with volume, size or frequency of trading, and XP is never money. Trading quests are one-offs
// ("your first call") so nothing nudges anyone to trade more.

export type ProgressSet = 'marketsViewed' | 'categories' | 'docsRead'

/** How a quest's progress is measured from the stored progress record. */
export type Measure =
  | { kind: 'count'; event: ProgressEvent } // times an event fired (or was backfilled)
  | { kind: 'distinct'; set: ProgressSet } // distinct markets / categories / doc pages
  | { kind: 'pages'; pages: string[] } // specific doc pages read

export type ChapterId = 'rookie' | 'room' | 'habits' | 'explorer'

export type Quest = {
  id: string
  chapter: ChapterId
  name: string
  description: string
  xp: number
  goal: number
  measure: Measure
  /** How it's measured, in plain words (shown on hover). */
  how: string
  cta: { label: string; href: string }
  /** Needs a connected wallet to be completed. */
  needsWallet?: boolean
}

export type Chapter = {
  id: ChapterId
  name: string
  tagline: string
  badge: { name: string; earn: string; shape: 'hex' | 'shield' | 'round' | 'diamond'; tone: 'yes' | 'highlight' | 'no' | 'ink' }
}

export const CHAPTERS: Chapter[] = [
  {
    id: 'rookie',
    name: 'Rookie run',
    tagline: 'Arc to Polymarket and back, once, end to end.',
    badge: { name: 'First light', earn: 'Finish every Rookie run quest.', shape: 'shield', tone: 'yes' },
  },
  {
    id: 'room',
    name: 'Read the room',
    tagline: 'Learn what a price, a book and a chart are telling you.',
    badge: { name: 'Chart whisperer', earn: 'Finish every Read the room quest.', shape: 'hex', tone: 'highlight' },
  },
  {
    id: 'habits',
    name: 'Sharp habits',
    tagline: 'The small routines that keep you out of trouble.',
    badge: { name: 'Steady hand', earn: 'Finish every Sharp habits quest.', shape: 'diamond', tone: 'no' },
  },
  {
    id: 'explorer',
    name: 'Explorer',
    tagline: 'Poke around. There is more here than one market.',
    badge: { name: 'Night owl', earn: 'Finish every Explorer quest.', shape: 'round', tone: 'ink' },
  },
]

const markets = routeHref({ name: 'markets' })
const wallet = routeHref({ name: 'wallet' })
const portfolio = routeHref({ name: 'portfolio' })
const doc = (page: string) => routeHref({ name: 'docs', page })

export const QUESTS: Quest[] = [
  // ---------- Rookie run ----------
  {
    id: 'read-the-route',
    chapter: 'rookie',
    name: 'Know the route',
    description: 'Read how your USDC travels from Arc to Polymarket.',
    xp: 20,
    goal: 1,
    measure: { kind: 'pages', pages: ['how-it-works'] },
    how: 'Open the How it works doc.',
    cta: { label: 'Read', href: doc('how-it-works') },
  },
  {
    id: 'connect-wallet',
    chapter: 'rookie',
    name: 'Say hi',
    description: 'Connect a wallet. Your keys stay yours.',
    xp: 20,
    goal: 1,
    measure: { kind: 'count', event: 'wallet_connected' },
    how: 'Connect any wallet once.',
    cta: { label: 'Connect', href: wallet },
  },
  {
    id: 'link-polymarket',
    chapter: 'rookie',
    name: 'Link up',
    description: 'Set up your Polymarket account from the Wallet page.',
    xp: 30,
    goal: 1,
    measure: { kind: 'count', event: 'account_linked' },
    how: 'Link or create your Polymarket account.',
    cta: { label: 'Go', href: wallet },
    needsWallet: true,
  },
  {
    id: 'first-deposit',
    chapter: 'rookie',
    name: 'Cross the bridge',
    description: 'Move a little USDC from Arc to Polymarket. A few dollars is plenty.',
    xp: 40,
    goal: 1,
    measure: { kind: 'count', event: 'deposit_done' },
    how: 'Complete one deposit from Arc, any size.',
    cta: { label: 'Deposit', href: wallet },
    needsWallet: true,
  },
  {
    id: 'first-call',
    chapter: 'rookie',
    name: 'Make the call',
    description: 'Yay or nay? Place your first prediction.',
    xp: 50,
    goal: 1,
    measure: { kind: 'count', event: 'trade_done' },
    how: 'Place one order, any size.',
    cta: { label: 'Browse', href: markets },
    needsWallet: true,
  },
  {
    id: 'round-trip',
    chapter: 'rookie',
    name: 'Round trip',
    description: 'Withdraw back to Arc, so you know the way home.',
    xp: 50,
    goal: 1,
    measure: { kind: 'count', event: 'withdraw_done' },
    how: 'Complete one withdrawal to Arc, any size.',
    cta: { label: 'Withdraw', href: wallet },
    needsWallet: true,
  },

  // ---------- Read the room ----------
  {
    id: 'window-shopper',
    chapter: 'room',
    name: 'Window shopper',
    description: 'Open five different markets and read the rules.',
    xp: 30,
    goal: 5,
    measure: { kind: 'distinct', set: 'marketsViewed' },
    how: 'Distinct market pages opened.',
    cta: { label: 'Browse', href: markets },
  },
  {
    id: 'book-worm',
    chapter: 'room',
    name: 'Open the book',
    description: 'Check an order book: who is bidding, who is asking.',
    xp: 25,
    goal: 1,
    measure: { kind: 'count', event: 'book_viewed' },
    how: 'View the order book on any market.',
    cta: { label: 'Browse', href: markets },
  },
  {
    id: 'candle-flip',
    chapter: 'room',
    name: 'Light the candles',
    description: 'Flip a price chart to candlesticks.',
    xp: 20,
    goal: 1,
    measure: { kind: 'count', event: 'chart_candles' },
    how: 'Switch any chart to candle view.',
    cta: { label: 'Browse', href: markets },
  },
  {
    id: 'zoom-out',
    chapter: 'room',
    name: 'Zoom out',
    description: 'Change a chart range. Today is not the whole story.',
    xp: 15,
    goal: 1,
    measure: { kind: 'count', event: 'chart_range_changed' },
    how: 'Pick a different chart range on any market.',
    cta: { label: 'Browse', href: markets },
  },
  {
    id: 'fine-print',
    chapter: 'room',
    name: 'Fine print',
    description: 'Read the Fees and Risks pages before they matter.',
    xp: 40,
    goal: 2,
    measure: { kind: 'pages', pages: ['fees', 'risks'] },
    how: 'Open both the Fees and the Risks docs.',
    cta: { label: 'Read', href: doc('fees') },
  },
  {
    id: 'many-roads',
    chapter: 'room',
    name: 'Many roads',
    description: 'Make a call on a market with more than two outcomes.',
    xp: 40,
    goal: 1,
    measure: { kind: 'count', event: 'multi_trade_done' },
    how: 'Place one order on a multi-outcome market, any size.',
    cta: { label: 'Browse', href: markets },
    needsWallet: true,
  },

  // ---------- Sharp habits ----------
  {
    id: 'lock-it-down',
    chapter: 'habits',
    name: 'Lock it down',
    description: 'Read the Security page: what we can and cannot touch.',
    xp: 30,
    goal: 1,
    measure: { kind: 'pages', pages: ['security'] },
    how: 'Open the Security doc.',
    cta: { label: 'Read', href: doc('security') },
  },
  {
    id: 'price-alert',
    chapter: 'habits',
    name: 'Set a tripwire',
    description: 'Set a price alert instead of refreshing all day.',
    xp: 30,
    goal: 1,
    measure: { kind: 'count', event: 'alert_set' },
    how: 'Set one price alert on any market.',
    cta: { label: 'Browse', href: markets },
  },
  {
    id: 'watchlist',
    chapter: 'habits',
    name: 'Shortlist',
    description: 'Watch three markets. Patience is a position too.',
    xp: 25,
    goal: 3,
    measure: { kind: 'count', event: 'watch_added' },
    how: 'Markets added to your watchlist.',
    cta: { label: 'Browse', href: markets },
  },
  {
    id: 'close-position',
    chapter: 'habits',
    name: 'Know when to fold',
    description: 'Close a position by selling it back. Exits are a skill.',
    xp: 40,
    goal: 1,
    measure: { kind: 'count', event: 'sell_done' },
    how: 'Sell any position, fully or partly.',
    cta: { label: 'Portfolio', href: portfolio },
    needsWallet: true,
  },
  {
    id: 'called-it',
    chapter: 'habits',
    name: 'Called it',
    description: 'Claim a win once a market resolves your way. No rush.',
    xp: 50,
    goal: 1,
    measure: { kind: 'count', event: 'claim_done' },
    how: 'Claim one resolved winning position.',
    cta: { label: 'Portfolio', href: portfolio },
    needsWallet: true,
  },

  // ---------- Explorer ----------
  {
    id: 'globetrotter',
    chapter: 'explorer',
    name: 'Globetrotter',
    description: 'Browse four different categories.',
    xp: 25,
    goal: 4,
    measure: { kind: 'distinct', set: 'categories' },
    how: 'Distinct market categories opened.',
    cta: { label: 'Browse', href: markets },
  },
  {
    id: 'seeker',
    chapter: 'explorer',
    name: 'Seeker',
    description: 'Search for a market you care about.',
    xp: 15,
    goal: 1,
    measure: { kind: 'count', event: 'search_used' },
    how: 'Run one market search.',
    cta: { label: 'Search', href: markets },
  },
  {
    id: 'pass-it-on',
    chapter: 'explorer',
    name: 'Pass it on',
    description: 'Copy a market link to share with a friend.',
    xp: 20,
    goal: 1,
    measure: { kind: 'count', event: 'share_copied' },
    how: 'Copy any market share link.',
    cta: { label: 'Browse', href: markets },
  },
  {
    id: 'night-shift',
    chapter: 'explorer',
    name: 'Night shift',
    description: 'Try the other theme. Cream paper or ink, your call.',
    xp: 15,
    goal: 1,
    measure: { kind: 'count', event: 'theme_switched' },
    how: 'Toggle the theme once (top right).',
    cta: { label: 'Toggle', href: '' },
  },
  {
    id: 'bookish',
    chapter: 'explorer',
    name: 'Bookish',
    description: 'Read five different help pages.',
    xp: 25,
    goal: 5,
    measure: { kind: 'distinct', set: 'docsRead' },
    how: 'Distinct doc pages opened.',
    cta: { label: 'Read', href: doc('faq') },
  },
]

export const TOTAL_XP = QUESTS.reduce((s, q) => s + q.xp, 0)

/** Levels, tuned so Oracle needs nearly every quest (total is 655 XP). */
export const LEVELS = [
  { name: 'Rookie', min: 0 },
  { name: 'Caller', min: 100 },
  { name: 'Analyst', min: 250 },
  { name: 'Sharp', min: 420 },
  { name: 'Oracle', min: 600 },
] as const
