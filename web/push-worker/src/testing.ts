// Test helpers: the receiving side of RFC 8291 (what a browser does) and a fresh subscriber key pair.
import { b64urlDecode, b64urlEncode, importP256Private } from '../../server/webpush.ts'

const enc = new TextEncoder()

/** Receiver side of RFC 8291, used to check our output independently of the fixed vector. */
export async function decryptPayload(body: Uint8Array<ArrayBuffer>, uaPrivate: string, uaPublic: string, auth: string): Promise<string> {
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const ct = body.slice(21 + idlen)
  if (rs !== 4096) throw new Error(`unexpected record size ${rs}`)
  const priv = await importP256Private(uaPrivate, uaPublic, 'ECDH')
  const pub = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256))
  const hk = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, k, n * 8))
  }
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...b64urlDecode(uaPublic), ...asPublic])
  const ikm = await hk(b64urlDecode(auth), ecdh, info, 32)
  const cek = await hk(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hk(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct))
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) end--
  if (padded[end] !== 2) throw new Error('missing last-record delimiter')
  return new TextDecoder().decode(padded.slice(0, end))
}

/** A browser-like subscriber: raw base64url keys suitable for encryptPayload and decryptPayload. */
export async function makeSubscriber() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const p256dh = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
  return { keys: { p256dh, auth }, privateKey: d as string }
}
