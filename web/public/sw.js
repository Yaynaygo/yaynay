// YayNay service worker: shows price-alert pushes. It caches nothing, so deploys are never stale.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/** Only same-origin app routes may be opened from a notification. */
function safeUrl(url) {
  return typeof url === 'string' && url.startsWith('/#/') ? url : '/'
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // Not JSON: fall back to a generic notification.
  }
  const title = typeof data.title === 'string' ? data.title.slice(0, 120) : 'YayNay'
  const body = typeof data.body === 'string' ? data.body.slice(0, 300) : ''
  const tag = typeof data.tag === 'string' ? data.tag : 'yaynay'
  const url = safeUrl(data.url)
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Open tabs mark the alert fired and add it to the inbox (deduped by alert id).
      for (const tab of tabs) {
        tab.postMessage({ type: 'yaynay:alert-fired', alertId: data.alertId, price: data.price, title, body, url })
      }
      // A focused tab already shows it in the app; the same tag replaces any local notification.
      if (tabs.some((t) => t.focused && t.visibilityState === 'visible')) return
      await self.registration.showNotification(title, { body, tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url } })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = safeUrl(event.notification.data && event.notification.data.url)
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin)
      if (tab) {
        tab.postMessage({ type: 'yaynay:open', url })
        return tab.focus()
      }
      return self.clients.openWindow(url)
    })(),
  )
})
