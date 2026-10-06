import { arc, polygon } from 'viem/chains'

export { arc, polygon }

// ---------- brand ----------
// The product name lives in src/brand.ts (Arc's brand rules forbid "Arc" in product names).
export { BRAND } from './brand'

// ---------- tokens ----------
// Arc's USDC ERC-20 interface reports 6 decimals; the native gas balance uses 18.
export const ARC_USDC = '0x3600000000000000000000000000000000000000' as const
export const ARC_USDC_DECIMALS = 6

export const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const
export const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as const
export const PUSD_DECIMALS = 6

// ---------- APIs (all public, called from the browser) ----------
export const GAMMA_API = 'https://gamma-api.polymarket.com'
export const DATA_API = 'https://data-api.polymarket.com'
export const CLOB_API = 'https://clob.polymarket.com'
export const POLY_BRIDGE_API = 'https://bridge.polymarket.com'
export const GEOBLOCK_API = 'https://polymarket.com/api/geoblock'
export const RELAY_API = 'https://api.relay.link'
export const SIGNER_URL = '/api/builder/sign'

// ---------- builder ----------
// Public by design: the builder code is serialized into every signed order.
export const BUILDER_CODE = (import.meta.env.VITE_BUILDER_CODE ?? '') as string
export const BUILDER_CODE_RE = /^0x[0-9a-fA-F]{64}$/
export const HAS_BUILDER_CODE = BUILDER_CODE_RE.test(BUILDER_CODE)

/** Headers for Polymarket bridge requests; the builder code attributes the traffic to us. */
export function bridgeHeaders(): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (HAS_BUILDER_CODE) h['X-Builder-Code'] = BUILDER_CODE
  return h
}

// ---------- limits & thresholds ----------
// Polymarket bridge minimum for Polygon native USDC is $2; the CCTP forwarder fee is deducted from the mint.
export const MIN_DEPOSIT_USDC = 2.5
// The bridge lists a $2 minimum (minCheckoutUsd); smaller withdrawals may not be processed.
export const MIN_WITHDRAW_PUSD = 2
/** Up to 6 decimals, the precision of USDC and pUSD. */
export const AMOUNT_RE = /^\d+(\.\d{1,6})?$/
/** A side priced at or above this is effectively decided: hidden from lists, gated in the trade panel. */
export const DECIDED_PRICE = 0.97
/** Recurring 5-minute/hourly crypto rounds that flood lists and tapes. */
export const RECURRING_ROUND_RE = /up or down/i

// 1-click trading (Polymarket Session Keys, beta) needs Polymarket to authorize our builder key for
// session-key management first. Off until then; set VITE_ONE_CLICK_TRADING=1 to show it.
export const ONE_CLICK_TRADING = import.meta.env.VITE_ONE_CLICK_TRADING === '1'

// ---------- links ----------
// Public project channels (overridable at build time).
export const LINKS = {
  github: (import.meta.env.VITE_GITHUB_URL || 'https://github.com/Yaynaygo/yaynay') as string,
  issues: (import.meta.env.VITE_GITHUB_URL || 'https://github.com/Yaynaygo/yaynay') + '/issues',
  x: (import.meta.env.VITE_X_URL || 'https://x.com/yaynay_app') as string,
  xHandle: '@yaynay_app',
  email: 'yaynay.go@gmail.com',
  contact: (import.meta.env.VITE_CONTACT || 'mailto:yaynay.go@gmail.com') as string,
  polymarketTos: 'https://polymarket.com/tos',
  polymarketRecovery: 'https://recovery.polymarket.com',
}

export const BUILD = {
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
}

export const explorer = {
  arcTx: (hash: string) => `${arc.blockExplorers?.default.url}/tx/${hash}`,
  arcAddress: (addr: string) => `${arc.blockExplorers?.default.url}/address/${addr}`,
  polygonTx: (hash: string) => `https://polygonscan.com/tx/${hash}`,
  polygonAddress: (addr: string) => `https://polygonscan.com/address/${addr}`,
}

export const shortAddress = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

// ---------- browser storage keys ----------
export const STORAGE = {
  theme: 'yaynay:theme',
  pendingDeposit: 'yaynay:pending-deposit',
  pendingWithdrawal: 'yaynay:pending-withdrawal',
  activity: 'yaynay:activity',
  clobCreds: (signer: string) => `yaynay:clob-creds:${signer.toLowerCase()}`,
  sessionKey: (owner: string, wallet: string) => `yaynay:session-key:${owner.toLowerCase()}:${wallet.toLowerCase()}`,
}

/** localStorage that never throws (private mode, blocked storage). */
export const store = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  },
  set(key: string, value: unknown) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage unavailable: the feature just doesn't persist.
    }
  },
}
