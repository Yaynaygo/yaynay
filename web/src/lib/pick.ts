import type { Pick } from '../components/EventCard'
import { navigate } from './router'

/** Opens a market page with the chosen outcome selected. */
export function openPick(p: Pick) {
  navigate({
    name: 'market',
    slug: p.event.slug,
    // Featured slides carry a single sub-market of a bigger event, so always name the market.
    marketId: p.market.id,
    side: p.outcome.tokenId === p.market.outcomes[1]?.tokenId ? 'no' : undefined,
  })
}
