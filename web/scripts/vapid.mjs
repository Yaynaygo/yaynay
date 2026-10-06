// Generates a VAPID key pair for Web Push (RFC 8292) with WebCrypto.
//   node scripts/vapid.mjs            prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY lines
//   node scripts/vapid.mjs >> .dev.vars   (gitignored) for local development
// Keep the private key secret: set it with `wrangler secret put`, never commit it.
const b64url = (buf) => Buffer.from(buf).toString('base64url')

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey))
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)

console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${d}`)
