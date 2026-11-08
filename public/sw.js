/*
 * Service worker do JARVIS 3.0 (PWA): deixa o app instalável, abre rápido
 * mesmo com rede ruim (a "casca" fica em cache) e recebe notificações push.
 * A API nunca é cacheada. Versão nova do app: troca o cache e assume sozinha.
 */
const VERSAO = 'jarvis-3.0.0'
const CASCA = ['/', '/index.html', '/manifest.webmanifest', '/icone-192.png', '/icone-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return
  // Arquivos com hash (assets/): cache primeiro. Páginas: rede primeiro, cache se offline.
  if (u.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(
        (r) =>
          r ||
          fetch(e.request).then((res) => {
            if (res.ok) caches.open(VERSAO).then((c) => c.put(e.request, res.clone()))
            return res
          }),
      ),
    )
    return
  }
  if (e.request.mode === 'navigate') e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')))
})

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { corpo: e.data?.text() }
  }
  e.waitUntil(self.registration.showNotification(d.titulo || 'J.A.R.V.I.S.', { body: d.corpo || '', icon: '/icone-192.png', badge: '/icone-192.png', tag: d.tag, data: { url: d.url || '/' }, lang: 'pt-BR' }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const alvo = new URL(e.notification.data?.url || '/', location.origin).href
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      const aberto = cs.find((c) => c.url.startsWith(location.origin))
      if (aberto) {
        aberto.navigate(alvo)
        return aberto.focus()
      }
      return self.clients.openWindow(alvo)
    }),
  )
})
