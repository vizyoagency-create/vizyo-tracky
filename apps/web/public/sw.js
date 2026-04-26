/**
 * V1.5 (Sprint M) — Service Worker Vizyo Tracky.
 *
 * Role minimal : recevoir les push notifications et les afficher.
 * Pas de mise en cache offline (out of scope V1.5).
 *
 * Activé manuellement via /account → toggle "Activer les notifications push"
 * (le browser register le SW + on subscribe via PushManager).
 */

self.addEventListener('install', (event) => {
  // Pas de cache pre-fetch — on prend effet immediatement.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Vizyo Tracky', body: '', url: '/' };
  try {
    if (event.data) {
      data = Object.assign(data, event.data.json());
    }
  } catch (err) {
    // payload non-JSON — utilise les defauts.
  }

  const options = {
    body: data.body,
    icon: data.icon || '/favicon.ico',
    badge: '/favicon.ico',
    data: { url: data.url || '/', ...data.data },
    requireInteraction: data.severity === 'CRITICAL',
    tag: data.tag,
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Si un onglet Tracky est deja ouvert, on l'utilise au lieu d'en ouvrir un nouveau.
      for (const w of windows) {
        if (w.url.includes(self.location.origin) && 'focus' in w) {
          w.focus();
          if ('navigate' in w) {
            w.navigate(targetUrl);
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});
