// Gets the HttpOnly session cookie that /api/builder/sign requires, after an invisible Cloudflare
// Turnstile check. Without VITE_TURNSTILE_SITE_KEY (local dev) the dev server issues it directly.

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '') as string
const REFRESH_MARGIN_MS = 10 * 60_000
const STORAGE_KEY = 'yaynay:api-session-exp'

type Turnstile = {
  render(el: HTMLElement, opts: Record<string, unknown>): string
  remove(id: string): void
}

let expiresAtMs = readStoredExpiry()
let inflight: Promise<void> | null = null

function readStoredExpiry(): number {
  try {
    return Number(sessionStorage.getItem(STORAGE_KEY) ?? 0)
  } catch {
    return 0
  }
}

function loadTurnstile(): Promise<Turnstile> {
  const w = window as unknown as { turnstile?: Turnstile }
  if (w.turnstile) return Promise.resolve(w.turnstile)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('Turnstile failed to load')))
    script.onerror = () => reject(new Error('Turnstile failed to load; check your connection or ad blocker'))
    document.head.appendChild(script)
  })
}

async function turnstileToken(): Promise<string> {
  const turnstile = await loadTurnstile()
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.bottom = '16px'
  host.style.right = '16px'
  host.style.zIndex = '1000'
  document.body.appendChild(host)
  try {
    let widgetId: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<string>((resolve, reject) => {
        widgetId = turnstile.render(host, {
          sitekey: SITE_KEY,
          // Stays invisible unless Cloudflare needs the user to click a checkbox.
          appearance: 'interaction-only',
          callback: (token: string) => resolve(token),
          'error-callback': () => reject(new Error('Bot check failed; reload the page and try again')),
          'timeout-callback': () => reject(new Error('Bot check timed out; try again')),
        })
        timer = setTimeout(() => reject(new Error('Bot check timed out; try again')), 60_000)
      })
    } finally {
      clearTimeout(timer)
      if (widgetId) turnstile.remove(widgetId)
    }
  } finally {
    host.remove()
  }
}

async function refresh() {
  const token = SITE_KEY ? await turnstileToken() : ''
  const res = await fetch('/api/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const body = (await res.json().catch(() => ({}))) as { expiresAt?: number; error?: string }
  if (!res.ok || !body.expiresAt) throw new Error(`Could not start a secure session: ${body.error ?? res.status}`)
  expiresAtMs = body.expiresAt * 1000
  try {
    sessionStorage.setItem(STORAGE_KEY, String(expiresAtMs))
  } catch {
    // ignore
  }
}

/** Ensures a valid signer session; call before any action that hits Polymarket's relayer or CLOB. */
export async function ensureApiSession(): Promise<void> {
  if (Date.now() + REFRESH_MARGIN_MS < expiresAtMs) return
  inflight ??= refresh().finally(() => {
    inflight = null
  })
  return inflight
}
