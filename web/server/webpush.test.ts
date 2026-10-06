import { describe, expect, it } from 'vitest'
import { decryptPayload as decrypt } from '../push-worker/src/testing.ts'
import { b64urlDecode, b64urlEncode, encryptPayload, isAllowedPushEndpoint, isValidPushKeys, vapidJwt } from './webpush.ts'

// RFC 8291, Appendix A.
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

const enc = new TextEncoder()

describe('webpush encryption (RFC 8291)', () => {
  it('reproduces the Appendix A test vector byte for byte', async () => {
    const out = await encryptPayload(enc.encode(V.plaintext), { p256dh: V.uaPublic, auth: V.auth }, {
      asKeys: { privateKey: V.asPrivate, publicKey: V.asPublic },
      salt: b64urlDecode(V.salt),
    })
    expect(b64urlEncode(out)).toBe(V.body)
  })

  it('decrypts the vector and a fresh random encryption', async () => {
    expect(await decrypt(b64urlDecode(V.body), V.uaPrivate, V.uaPublic, V.auth)).toBe(V.plaintext)
    const msg = JSON.stringify({ title: 'Yes hit 72¢', body: 'Will it rain?' })
    const out = await encryptPayload(enc.encode(msg), { p256dh: V.uaPublic, auth: V.auth })
    expect(await decrypt(out, V.uaPrivate, V.uaPublic, V.auth)).toBe(msg)
  })

  it('rejects oversized payloads and malformed keys', async () => {
    await expect(encryptPayload(new Uint8Array(5000), { p256dh: V.uaPublic, auth: V.auth })).rejects.toThrow(/too large/)
    expect(await isValidPushKeys({ p256dh: V.uaPublic, auth: V.auth })).toBe(true)
    expect(await isValidPushKeys({ p256dh: V.uaPublic, auth: 'AAAA' })).toBe(false)
    expect(await isValidPushKeys({ p256dh: 'BAAA', auth: V.auth })).toBe(false)
    // A point that is not on the curve.
    const bad = b64urlDecode(V.uaPublic)
    bad[64] ^= 1
    expect(await isValidPushKeys({ p256dh: b64urlEncode(bad), auth: V.auth })).toBe(false)
  })
})

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 JWT that verifies with the public key', async () => {
    const vapid = { publicKey: V.asPublic, privateKey: V.asPrivate, subject: 'mailto:ops@example.com' }
    const jwt = await vapidJwt('https://fcm.googleapis.com', vapid, 1_700_000_000_000)
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_700_000_000 + 12 * 3600,
      sub: 'mailto:ops@example.com',
    })
    const pub = await crypto.subtle.importKey('raw', b64urlDecode(V.asPublic), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const sig = b64urlDecode(s)
    expect(sig.length).toBe(64)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, enc.encode(`${h}.${c}`))).toBe(true)
  })
})

describe('push endpoint allowlist', () => {
  it('accepts the major push services only', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:def')).toBe(true)
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAA')).toBe(true)
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QGx')).toBe(true)
    expect(isAllowedPushEndpoint('https://wns2-db5p.notify.windows.com/w/?token=x')).toBe(true)
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false)
    expect(isAllowedPushEndpoint('https://evil.com/fcm.googleapis.com')).toBe(false)
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false)
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false)
    expect(isAllowedPushEndpoint('https://user@fcm.googleapis.com/x')).toBe(false)
  })
})
