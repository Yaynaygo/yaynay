import { describe, expect, it } from 'vitest'
import { faviconUrl, relevant, leadingOdds, monogram, moveSince, newsQuery, pairHeadlines } from './news'

describe('newsQuery', () => {
  it('reduces a matchup to its two sides', () => {
    expect(newsQuery('Counter-Strike: Team Falcons vs Natus Vincere (BO3) - ESL Pro League Group Stage')).toBe('team falcons vs natus vincere')
    expect(newsQuery('Chicago Fire FC vs. Vancouver Whitecaps FC')).toBe('chicago fire fc vs vancouver whitecaps fc')
  })
  it('drops question framing and filler words', () => {
    expect(newsQuery('Will Benjamin Netanyahu be the next Prime Minister of Israel?')).toBe('benjamin netanyahu prime minister israel')
    expect(newsQuery('Fed decision in October')).toBe('fed decision october')
  })
  it('drops ISO dates and caps the length', () => {
    expect(newsQuery('Will Albania win on 2026-10-06?')).toBe('albania')
    expect(newsQuery('Will there be no change in Fed interest rates after the October 2026 meeting?')).toBe('no change fed interest rates october')
  })
  it('keeps tickers and numbers', () => {
    expect(newsQuery('Bitcoin above $150k on December 31?')).toBe('bitcoin 150k december 31')
  })
})

describe('monogram', () => {
  it('uses the first letter of a name or domain', () => {
    expect(monogram('Reuters')).toBe('R')
    expect(monogram('finance.yahoo.com')).toBe('Y')
    expect(monogram('The Wall Street Journal')).toBe('W')
  })
})

describe('leadingOdds', () => {
  const ev = (markets: { label: string; outcomes: { name: string; price: number }[] }[]) => ({ slug: 's', title: 't', markets })
  it('uses Yes for a single market', () => {
    expect(leadingOdds(ev([{ label: '', outcomes: [{ name: 'Yes', price: 0.62 }, { name: 'No', price: 0.38 }] }]))).toEqual({ label: 'Yes', chance: 0.62 })
  })
  it('picks the favourite in a multi-outcome event', () => {
    const out = leadingOdds(
      ev([
        { label: 'Philippe', outcomes: [{ name: 'Yes', price: 0.18 }] },
        { label: 'Le Pen', outcomes: [{ name: 'Yes', price: 0.43 }] },
      ]),
    )
    expect(out).toEqual({ label: 'Le Pen', chance: 0.43 })
  })
  it('is null without prices', () => {
    expect(leadingOdds(ev([]))).toBeNull()
  })
})

describe('pairHeadlines', () => {
  const n = (url: string, t: number) => ({ title: url, url, source: 'S', publishedAt: t })
  const ev = (slug: string) => ({ slug, title: slug, markets: [] })
  it('interleaves events and drops repeated links', () => {
    const out = pairHeadlines([
      { event: ev('a'), items: [n('a1', 9), n('a2', 8), n('a3', 7)] },
      { event: ev('b'), items: [n('a1', 9), n('b1', 6)] },
    ])
    expect(out.map((h) => h.url)).toEqual(['a1', 'b1', 'a2'])
    expect(out[1].event.slug).toBe('b')
  })
})

describe('moveSince', () => {
  const h = [
    { t: 100, p: 0.4 },
    { t: 200, p: 0.45 },
    { t: 300, p: 0.5 },
    { t: 400, p: 0.49 },
  ]
  it('measures from the last price at or before the story', () => {
    expect(moveSince(h, 250)).toBeCloseTo(0.04)
    expect(moveSince(h, 100)).toBeCloseTo(0.09)
    expect(moveSince(h, 400)).toBeCloseTo(0)
  })
  it('is null for stories older than the history or thin data', () => {
    expect(moveSince(h, 50)).toBeNull()
    expect(moveSince([{ t: 1, p: 0.5 }], 2)).toBeNull()
  })
})

describe('faviconUrl', () => {
  it('uses the publisher host, not the article redirect', () => {
    expect(faviconUrl({ title: 't', url: 'https://news.google.com/x', source: 'Reuters', sourceUrl: 'https://www.reuters.com', publishedAt: 1 })).toBe(
      'https://www.google.com/s2/favicons?domain=www.reuters.com&sz=64',
    )
    expect(faviconUrl({ title: 't', url: 'https://a.com', source: 'A', publishedAt: 1 })).toBeUndefined()
  })
})

describe('relevant', () => {
  const t = (title: string) => ({ title })
  it('drops headlines that name nothing from the query', () => {
    expect(relevant([t('SpaceX Solar System Connectivity'), t("Musk's posting spree continues")], 'elon musk tweets october').map((x) => x.title)).toEqual([
      "Musk's posting spree continues",
    ])
  })
  it('ignores generic words like years and months', () => {
    expect(relevant([t('Live EFL fixtures for 2027')], 'uefa champions league 2027 champion')).toHaveLength(0)
    expect(relevant([t('Champions League draw made')], 'uefa champions league 2027 champion')).toHaveLength(1)
  })
  it('keeps everything when the query has no distinctive word', () => {
    expect(relevant([t('a')], 'fed')).toHaveLength(1)
  })
})

describe('relevant (sports)', () => {
  it('needs more than a shared "league" to count', () => {
    expect(relevant([{ title: 'Live EFL fixtures: Championship, League One' }], 'uefa champions league 2027 champion')).toHaveLength(0)
  })
})
