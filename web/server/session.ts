import { hmacHex, safeEqual } from './hmac.ts'

// A short-lived, HttpOnly session cookie that proves the browser passed a Turnstile check.
// The builder signer only serves requests that carry it, so plain scripts cannot use our quota.

export const SESSION_COOKIE = 'yaynay_s'
export const SESSION_TTL_S = 12 * 60 * 60

export type SessionEnv = { SESSION_SECRET?: string; TURNSTILE_SECRET_KEY?: string }

export async function verifyTurnstile(token: string, secret: string, ip?: string | null): Promise<boolean> {
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', token)
  if (ip) form.append('remoteip', ip)
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  if (!res.ok) return false
  const body = (await res.json()) as { success?: boolean }
  return body.success === true
}

export async function createSessionCookie(secret: string, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_S
  const id = crypto.randomUUID()
  const payload = `${expiresAt}.${id}`
  const value = `${payload}.${await hmacHex(secret, payload)}`
  const cookie = `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${SESSION_TTL_S}`
  return { cookie, expiresAt }
}

export async function hasValidSession(cookieHeader: string | null, secret: string, now = Date.now()): Promise<boolean> {
  const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  if (!match) return false
  const [expiresAt, id, mac] = match[1].split('.')
  if (!expiresAt || !id || !mac) return false
  if (Number(expiresAt) * 1000 < now) return false
  return safeEqual(mac, await hmacHex(secret, `${expiresAt}.${id}`))
}
