import { useEffect, useState } from 'react'

// Hash routes keep the app a single static page on Cloudflare Pages while giving every view,
// market and doc page a shareable URL and a working Back button.
//   #/markets  #/portfolio  #/wallet[?d=withdraw]  #/quests  #/docs/<page>
//   #/market/<event-slug>?m=<market-id>&o=yes|no
//   #/leaderboard   #/u/<polymarket-wallet>   a public, read-only caller profile
export type Side = 'yes' | 'no'

export type Route =
  | { name: 'markets' }
  | { name: 'portfolio' }
  | { name: 'wallet'; dir?: 'deposit' | 'withdraw' }
  | { name: 'quests' }
  | { name: 'leaderboard' }
  | { name: 'market'; slug: string; marketId?: string; side?: Side }
  | { name: 'docs'; page: string }
  | { name: 'profile'; wallet: string }

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const [head, arg] = path.split('/').filter(Boolean)
  if (head === 'portfolio') return { name: 'portfolio' }
  if (head === 'wallet') {
    const dir = new URLSearchParams(query).get('d')
    return dir === 'withdraw' || dir === 'deposit' ? { name: 'wallet', dir } : { name: 'wallet' }
  }
  if (head === 'u' && arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) return { name: 'profile', wallet: arg.toLowerCase() }
  if (head === 'quests') return { name: 'quests' }
  if (head === 'leaderboard') return { name: 'leaderboard' }
  if (head === 'market' && arg) {
    const params = new URLSearchParams(query)
    const side = params.get('o')
    return {
      name: 'market',
      slug: decodeURIComponent(arg),
      marketId: params.get('m') ?? undefined,
      side: side === 'yes' || side === 'no' ? side : undefined,
    }
  }
  if (head === 'docs') return { name: 'docs', page: arg ? decodeURIComponent(arg) : 'how-it-works' }
  return { name: 'markets' }
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'market': {
      const params = new URLSearchParams()
      if (route.marketId) params.set('m', route.marketId)
      if (route.side) params.set('o', route.side)
      const query = params.toString()
      return `#/market/${encodeURIComponent(route.slug)}${query ? `?${query}` : ''}`
    }
    case 'docs':
      return `#/docs/${encodeURIComponent(route.page)}`
    case 'wallet':
      return route.dir ? `#/wallet?d=${route.dir}` : '#/wallet'
    case 'profile':
      return `#/u/${route.wallet}`
    default:
      return `#/${route.name}`
  }
}

/** Pushes a history entry, so Back returns to the previous view. */
export function navigate(route: Route) {
  const href = routeHref(route)
  if (window.location.hash !== href) window.location.hash = href
}

/** Updates the address bar without a new history entry or a re-route (e.g. switching outcomes on a market page). */
export function replaceRoute(route: Route) {
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${routeHref(route)}`)
}

// The market list stays mounted behind a market page, so Back can return to the same scroll position.
let listScroll = 0

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    let current = parseRoute(window.location.hash)
    const onChange = () => {
      const next = parseRoute(window.location.hash)
      if (current.name === 'markets') listScroll = window.scrollY
      const backToList = next.name === 'markets' && current.name === 'market'
      current = next
      setRoute(next)
      if (backToList) requestAnimationFrame(() => window.scrollTo({ top: listScroll }))
      else window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
