import { GAMMA_API } from '../config'

// Polymarket Protocol V2 markets trade their positions under V2 position IDs (Gamma `positionIds`)
// instead of the CTF token IDs (`clobTokenIds`), settle on ExchangeV3, and keep balances in the
// PositionManager. A market's `version` says which. Everything else (pUSD, wallets, CLOB credentials,
// endpoints) is shared, so the rest of the app only needs the right ID and asset type.

export type ProtocolVersion = 'v1' | 'v2'

type IdSource = { version?: string; clobTokenIds?: string | string[]; positionIds?: string | string[] }

function list(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.map(String)
  try {
    return v ? (JSON.parse(v) as string[]).map(String) : []
  } catch {
    return []
  }
}

export const versionOf = (raw: { version?: string }): ProtocolVersion => (raw.version?.toLowerCase() === 'v2' ? 'v2' : 'v1')

/** The IDs to trade, quote and stream for each outcome, in outcome order. */
export function tradingIds(raw: IdSource): { version: ProtocolVersion; ids: string[] } {
  const version = versionOf(raw)
  return { version, ids: version === 'v2' ? list(raw.positionIds) : list(raw.clobTokenIds) }
}

const versions = new Map<string, Promise<ProtocolVersion>>()

/**
 * A market's protocol version by condition ID, for positions read from the Data API (which doesn't
 * say). Cached per condition; unknown or failed lookups fall back to V1, the only version before V2.
 */
export function marketVersion(conditionId: string, fetcher: typeof fetch = fetch): Promise<ProtocolVersion> {
  const key = conditionId.toLowerCase()
  let hit = versions.get(key)
  if (!hit) {
    hit = fetcher(`${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}&closed=any&limit=1`)
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }[]>) : []))
      .then((rows) => (Array.isArray(rows) && rows[0] ? versionOf(rows[0]) : 'v1'))
      .catch(() => {
        versions.delete(key)
        return 'v1' as const
      })
    versions.set(key, hit)
  }
  return hit
}

/** Test hook. */
export const clearVersionCache = () => versions.clear()
