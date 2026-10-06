import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetNotifications,
  addToList,
  clearNotifications,
  getNotifications,
  markAllRead,
  markRead,
  MAX_NOTIFICATIONS,
  notify,
  type AppNotification,
} from './notifications'
import { toast } from './toast'

const n = (id: string): AppNotification => ({ id, kind: 'info', title: id, createdAt: 0, read: false })

describe('notifications store', () => {
  beforeEach(() => _resetNotifications())

  it('keeps newest first and caps the inbox', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS + 5; i++) notify({ kind: 'trade', title: `t${i}` })
    const items = getNotifications()
    expect(items).toHaveLength(MAX_NOTIFICATIONS)
    expect(items[0].title).toBe(`t${MAX_NOTIFICATIONS + 4}`)
  })

  it('dedupes by id', () => {
    notify({ id: 'win:1', kind: 'win', title: 'You called it!' })
    notify({ id: 'win:1', kind: 'win', title: 'You called it!' })
    expect(getNotifications()).toHaveLength(1)
    expect(addToList([n('a')], n('a'))).toHaveLength(1)
  })

  it('marks read and clears', () => {
    const a = notify({ kind: 'info', title: 'a' })
    notify({ kind: 'info', title: 'b' })
    markRead(a)
    expect(getNotifications().filter((x) => !x.read)).toHaveLength(1)
    markAllRead()
    expect(getNotifications().every((x) => x.read)).toBe(true)
    clearNotifications()
    expect(getNotifications()).toHaveLength(0)
  })

  it('copies a success toast into the inbox once, not on updates', () => {
    const id = toast({ kind: 'info', title: 'Deposit in progress' })
    expect(getNotifications()).toHaveLength(0)
    toast({ kind: 'success', title: 'Deposit complete', detail: '5 USDC' }, id)
    toast({ kind: 'success', title: 'Deposit complete', detail: '5 USDC' }, id)
    toast({ kind: 'success', title: 'Withdrawal arrived on Arc' })
    toast({ kind: 'success', title: 'Order filled' })
    expect(getNotifications().map((x) => x.kind)).toEqual(['trade', 'withdraw', 'deposit'])
  })
})
