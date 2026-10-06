import { GEOBLOCK_API } from '../config'

// Source: https://docs.polymarket.com/api-reference/geoblock (checked 2026-10-05).
const BLOCKED = new Set(['IR', 'SY', 'CU', 'KP', 'UA-43', 'UA-14', 'UA-09'])
const CLOSE_ONLY = new Set([
  'AU', 'BY', 'BE', 'BI', 'BR', 'CA-BC', 'CA-ON', 'CA-AB', 'CA-QC', 'CF', 'CD', 'ET', 'FR', 'DE',
  'IQ', 'IT', 'LB', 'LY', 'MM', 'NZ', 'NI', 'PL', 'RU', 'SG', 'SO', 'SK', 'SS', 'SD', 'TW', 'TH',
  'GB', 'US', 'UM', 'VE', 'YE', 'ZW',
  // Close-only on Polymarket's frontend only; the ToS still restricts them, so we do too.
  'IE', 'JP', 'NL', 'KR', 'MT',
])

export type Access = 'open' | 'close-only' | 'blocked'

export type GeoResult = {
  access: Access
  country: string
  region: string
}

export function classify(country: string, region: string, apiBlocked: boolean): Access {
  const subdivision = region ? `${country}-${region}` : ''
  if (BLOCKED.has(country) || BLOCKED.has(subdivision)) return 'blocked'
  if (CLOSE_ONLY.has(country) || CLOSE_ONLY.has(subdivision)) return 'close-only'
  // The API reports blocked for jurisdictions we have not listed yet; fail closed.
  return apiBlocked ? 'close-only' : 'open'
}

// Must run in the user's browser: the endpoint geolocates the caller's IP.
export async function checkGeoblock(): Promise<GeoResult> {
  const res = await fetch(GEOBLOCK_API)
  if (!res.ok) throw new Error(`geoblock check failed: ${res.status}`)
  const body = (await res.json()) as { blocked: boolean; country: string; region: string }
  return {
    access: classify(body.country, body.region, body.blocked),
    country: body.country,
    region: body.region,
  }
}
