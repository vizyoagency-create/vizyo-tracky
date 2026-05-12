/**
 * V1.5 (Sprint M) — Service Worker Vizyo Tracky.
 *
 * Role minimal : recevoir les push notifications et les afficher.
 * Pas de mise en cache offline (out of scope V1.5).
 *
 * Active manuellement via /account → toggle "Activer les notifications push"
 * (le browser register le SW + on subscribe via PushManager).
 *
 * V1.8 (web-push-finalize) — payload enrichi :
 *   - severity: 'INFO' | 'WARNING' | 'CRITICAL' -> pattern vibration + requireInteraction
 *   - tag: alertId -> regroupement (un push par alerte, un re-push remplace)
 *   - actions: [Acquitter, Voir]
 *     - "ack"  : POST /api/alerts/:id/acknowledge en passant par un client focus
 *                qui a le JWT (le SW n'a pas le token, on lui delegue l'appel HTTP)
 *     - "view" : ouvre/focus un onglet sur data.url
 */

self.addEventListener('install', () => {
  // Pas de cache pre-fetch — on prend effet immediatement.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Vizyo Tracky', body: '', url: '/', severity: 'INFO' };
  try {
    if (event.data) {
      data = Object.assign(data, event.data.json());
    }
  } catch {
    // payload non-JSON — utilise les defauts.
  }

  const isCritical = data.severity === 'CRITICAL';

  // Pattern vibration : long-court-long-court-long pour CRITICAL (motif urgence
  // simplifie), pulse court pour WARNING/INFO. Cote SW : navigator.vibrate n'est
  // pas universel (ignore sur desktop, OK Android Chrome). On laisse le browser
  // decider via le champ vibrate des NotificationOptions.
  const vibrate = isCritical ? [200, 100, 200, 100, 200] : [100];

  // Icones :
  //   - `icon` = grande icone affichee dans la notif (Android Chrome upscale a 192px+).
  //     /favicon.ico (32px ICO) etait flou + mal tinte. /pwa-icon-192.png = silhouette
  //     V verte propre, rendu net.
  //   - `badge` = petite icone monochrome dans la barre de statut Android (tinted
  //     blanc force par le systeme). pwa-icon-192.png a une silhouette dominante
  //     qui tinte proprement. Pour un badge encore meilleur, fournir a terme un
  //     PNG dedie monochrome (V noir sur fond transparent, 96x96).
  const options = {
    body: data.body,
    icon: data.icon || '/pwa-icon-192.png',
    badge: data.badge || '/pwa-icon-192.png',
    data: {
      url: data.url || '/',
      alertId: data.data && data.data.alertId,
      severity: data.severity,
      ...(data.data || {}),
    },
    requireInteraction: isCritical,
    vibrate,
    tag: data.tag,
    // renotify: re-jouer le son meme si une notif avec le meme tag existe deja.
    // Pertinent pour les CRITICAL re-poussees (escalade) — sinon le browser
    // remplace silencieusement et l'utilisateur peut rater l'escalade.
    renotify: isCritical && !!data.tag,
    actions: [
      { action: 'ack', title: 'Acquitter' },
      { action: 'view', title: 'Voir' },
    ],
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, options),
      // Notifie tous les clients ouverts pour qu'ils mettent a jour le toast in-app
      // / la cloche d'alertes meme si la WS etait deconnectee. Best-effort.
      notifyClients({ type: 'PUSH_RECEIVED', payload: data }),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;
  const data = event.notification.data || {};
  const targetUrl = data.url || '/';
  const alertId = data.alertId;

  event.waitUntil((async () => {
    if (action === 'ack' && alertId) {
      // Le SW n'a pas le JWT en memoire — on demande au premier client
      // disponible de faire l'appel HTTP authentifie. Si aucun client n'est
      // ouvert, on ouvre l'app sur /alerts?ack=<id> qui prendra le relais.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = pickClient(clients);
      if (target) {
        target.postMessage({ type: 'ACK_ALERT', alertId });
        if ('focus' in target) await target.focus();
        return;
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(`/alerts?ack=${encodeURIComponent(alertId)}`);
      }
      return;
    }

    // action === 'view' OU clic sur le corps de la notif (action vide).
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          try { await client.navigate(targetUrl); } catch { /* ignore */ }
        } else {
          client.postMessage({ type: 'NAVIGATE', url: targetUrl });
        }
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

function pickClient(clients) {
  const focused = clients.find((c) => c.focused && c.visibilityState === 'visible');
  if (focused) return focused;
  const visible = clients.find((c) => c.visibilityState === 'visible');
  if (visible) return visible;
  return clients[0] || null;
}

async function notifyClients(message) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      try { client.postMessage(message); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
