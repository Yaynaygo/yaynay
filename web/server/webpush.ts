// Web Push with nothing but WebCrypto: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).
// Runs in Cloudflare Workers, Pages Functions and Node 20+.

export type PushKeys = { p256dh: string; auth: string }
export type PushSubscriptionLike = { endpoint: string; keys: PushKeys }

export type VapidConfig = {
  /** Uncompressed P-256 public key, base64url (65 bytes). */
  publicKey: string
  /** Private key: raw `d` as base64url (32 bytes) or a JWK JSON string. */
  privateKey: string
  /** `mailto:` address or https URL the push service can contact. */
  subject: string
}

const enc = new TextEncoder()

// Derived from the global WebCrypto so this file typechecks with or without the DOM lib.
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>
type Jwk = { kty?: string; crv?: string; x?: string; y?: string; d?: string; ext?: boolean; key_ops?: string[]; alg?: string }

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('invalid base64url')
  const bin = atob(s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Public JWK coordinates from an uncompressed point (0x04 || x || y). */
function pointToJwk(point: Uint8Array): Jwk {
  if (point.length !== 65 || point[0] !== 4) throw new Error('expected an uncompressed P-256 public key')
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(point.slice(1, 33)), y: b64urlEncode(point.slice(33)), ext: true }
}

/** Imports a P-256 private key given as raw base64url `d` (plus its public point) or as a JWK JSON string. */
export async function importP256Private(privateKey: string, publicKey: string, usage: 'ECDSA' | 'ECDH'): Promise<Key> {
  const jwk: Jwk = privateKey.trim().startsWith('{')
    ? (JSON.parse(privateKey) as Jwk)
    : { ...pointToJwk(b64urlDecode(publicKey)), d: privateKey.trim() }
  delete jwk.key_ops
  delete jwk.alg
  if (usage === 'ECDSA') return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
}

/** True when `p256dh` is a valid point on P-256 and `auth` is 16 bytes. */
export async function isValidPushKeys(keys: PushKeys): Promise<boolean> {
  try {
    if (b64urlDecode(keys.auth).length !== 16) return false
    await crypto.subtle.importKey('raw', b64urlDecode(keys.p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    return true
  } catch {
    return false
  }
}

// ---------- VAPID (RFC 8292) ----------

/** Signed ES256 JWT for one push service origin. */
export async function vapidJwt(audience: string, vapid: VapidConfig, now = Date.now(), ttlSeconds = 12 * 3600): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + ttlSeconds, sub: vapid.subject })))
  const key = await importP256Private(vapid.privateKey, vapid.publicKey, 'ECDSA')
  // WebCrypto returns the raw r || s form that JWS expects (not DER).
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`))
  return `${header}.${claims}.${b64urlEncode(new Uint8Array(sig))}`
}

export async function vapidAuthorization(endpoint: string, vapid: VapidConfig, now = Date.now()): Promise<string> {
  const jwt = await vapidJwt(new URL(endpoint).origin, vapid, now)
  return `vapid t=${jwt}, k=${vapid.publicKey}`
}

// ---------- Payload encryption (RFC 8291 + RFC 8188) ----------

export const RECORD_SIZE = 4096
/** Largest plaintext that fits one record: rs - 16 (tag) - 1 (delimiter); the 86-byte header sits outside the record. */
export const MAX_PLAINTEXT = RECORD_SIZE - 17

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

export type EncryptOptions = {
  /** Fixed sender key pair, for test vectors only. Raw base64url `d` and uncompressed public point. */
  asKeys?: { privateKey: string; publicKey: string }
  /** Fixed 16-byte salt, for test vectors only. */
  salt?: Uint8Array<ArrayBuffer>
}

/** Encrypts one message for a subscription; returns the full aes128gcm body (header + single record). */
export async function encryptPayload(plaintext: Uint8Array<ArrayBuffer>, keys: PushKeys, opts: EncryptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('push payload too large')
  const uaPublic = b64urlDecode(keys.p256dh)
  const authSecret = b64urlDecode(keys.auth)
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes')
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])

  let asPrivate: Key
  let asPublic: Uint8Array<ArrayBuffer>
  if (opts.asKeys) {
    asPrivate = await importP256Private(opts.asKeys.privateKey, opts.asKeys.publicKey, 'ECDH')
    asPublic = b64urlDecode(opts.asKeys.publicKey)
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    asPrivate = pair.privateKey
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  }

  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256))
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
  if (salt.length !== 16) throw new Error('salt must be 16 bytes')
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  // Single, last record: plaintext followed by the 0x02 delimiter and no extra padding.
  const record = concat(plaintext, new Uint8Array([2]))
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record))

  const header = new Uint8Array(21)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = asPublic.length
  return concat(header, asPublic, sealed)
}

// ---------- Sending ----------

export type PushMessage = {
  title: string
  body: string
  /** Same-origin path the notification opens, e.g. "/#/market/<slug>". */
  url: string
  /** Notification tag; a newer notification with the same tag replaces the old one. */
  tag: string
  alertId?: string
  price?: number
}

export type SendResult = {
  status: number
  /** The subscription is gone (404/410) and must be deleted. */
  gone: boolean
  ok: boolean
}

export async function sendPush(
  sub: PushSubscriptionLike,
  message: PushMessage,
  vapid: VapidConfig,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; fetcher?: typeof fetch; authorization?: string } = {},
): Promise<SendResult> {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub.keys)
  const res = await (opts.fetcher ?? fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: opts.authorization ?? (await vapidAuthorization(sub.endpoint, vapid)),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl ?? 3600),
      Urgency: opts.urgency ?? 'high',
    },
    body,
  })
  // Drain the body so the connection can be reused.
  await res.arrayBuffer().catch(() => undefined)
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 }
}

/** Push services we deliver to. Anything else is refused so the checker can't be aimed at arbitrary URLs. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/]

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false
  try {
    const u = new URL(endpoint)
    return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && PUSH_HOSTS.some((re) => re.test(u.hostname))
  } catch {
    return false
  }
}
