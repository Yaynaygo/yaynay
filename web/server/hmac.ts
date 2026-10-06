// Polymarket builder HMAC, matching @polymarket/client's buildHmacSignature:
// HMAC-SHA256 over `${timestamp}${method}${path}${body}` with the base64(url) secret as key,
// returned as URL-safe base64 with padding kept. WebCrypto only, so it runs on Workers and Node.

function decodeSecret(secret: string): Uint8Array {
  const b64 = secret.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export async function builderSignature(
  secret: string,
  timestamp: number,
  method: string,
  path: string,
  body?: string,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', decodeSecret(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const message = new TextEncoder().encode(`${timestamp}${method}${path}${body ?? ''}`)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/** Hex HMAC-SHA256 with a UTF-8 key; used for our own session cookies. */
export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
