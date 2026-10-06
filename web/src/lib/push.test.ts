import { describe, expect, it } from 'vitest'
import { dropOldSubscription, pushTargets } from './push'
import type { PriceAlert } from './alerts'

describe('push client', () => {
  it('deletes the server copy before dropping a rotated subscription', async () => {
    const calls: string[] = []
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/old', unsubscribe: async () => (calls.push('browser'), true) }
    await dropOldSubscription(sub, async (path, body) => {
      calls.push(`${path} ${(body as { endpoint: string }).endpoint}`)
      return new Response('{}', { status: 200 })
    })
    expect(calls).toEqual(['/api/push/unsubscribe https://fcm.googleapis.com/fcm/send/old', 'browser'])
  })

  it('keeps the browser subscription when the server delete fails', async () => {
    let dropped = false
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/old', unsubscribe: async () => (dropped = true) }
    await expect(dropOldSubscription(sub, async () => new Response('{}', { status: 500 }))).rejects.toThrow()
    expect(dropped).toBe(false)
  })

  it('syncs only armed alerts in the shape the API accepts', () => {
    const base = { slug: 's', title: 't', outcome: 'Yes', op: 'above' as const, createdAt: 1 }
    const list: PriceAlert[] = [
      { ...base, id: 'a', tokenId: '123', price: 0.5 },
      { ...base, id: 'b', tokenId: '123', price: 0.5, firedAt: 2 },
      { ...base, id: 'c', tokenId: '0xabc', price: 0.5 },
    ]
    expect(pushTargets(list)).toEqual([{ id: 'a', tokenId: '123', op: 'above', price: 0.5, title: 't', slug: 's', outcome: 'Yes' }])
  })
})
