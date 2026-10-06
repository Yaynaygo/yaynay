import type { PolyClient } from './polyAccount'
import { STORAGE } from '../config'

// Polymarket L2 API credentials for the user's own account (not a private key). Keeping them
// lets a page reload restore the session without asking for a new login signature. Orders still
// need a fresh wallet signature each time.
type Creds = PolyClient['credentials']

const key = STORAGE.clobCreds

export function loadCreds(signer: string): Creds | undefined {
  try {
    const raw = localStorage.getItem(key(signer))
    return raw ? (JSON.parse(raw) as Creds) : undefined
  } catch {
    return undefined
  }
}

export function saveCreds(signer: string, creds: Creds) {
  try {
    localStorage.setItem(key(signer), JSON.stringify(creds))
  } catch {
    // Storage can be unavailable (private mode); the user just signs in again next time.
  }
}

export function clearCreds(signer: string) {
  try {
    localStorage.removeItem(key(signer))
  } catch {
    // ignore
  }
}
