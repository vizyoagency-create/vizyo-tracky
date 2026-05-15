// SW build marker — V1.13 bg fusion aggressive (force re-install)
/**
 * V1.11 — Service Worker COMBINE Vizyo Tracky.
 *
 * Strategie : un SEUL SW au scope `/`, qui combine
 *   1. Le SW Angular (ngsw-worker.js, charge via importScripts en prod) pour :
 *      - cache offline du shell (assetGroups dans ngsw-config.json)
 *      - dataGroups (cache /api/vehicles/snapshot, /api/alerts)
 *      - SwUpdate (detection nouvelle version + modal forcer reload)
 *      - display auto des notifs avec le payload `notification: {...}`
 *      - dispatch SwPush.messages$ / notificationClicks$ aux clients
 *   2. Notre logique custom additionnelle, qui ne casse pas ngsw :
 *      - setAppBadge(N) sur chaque push (Badge API : iOS 16.4+ standalone PWA,
 *        Chrome desktop, Chrome Android partial). MARCHE EN BACKGROUND meme
 *        app fermee, contrairement a un appel main-thread.
 *      - notificationclick : delegation Acquitter/Voir au client open (qui a
 *        le JWT), avec fallback openWindow si aucun client n'est focused.
 *      - PUSH_RECEIVED postMessage aux clients pour rafraichir la cloche
 *        d'alertes meme quand WS est deconnectee.
 *
 * Pourquoi un seul SW : le W3C autorise un seul SW actif par (origin, scope).
 * Avec 2 SWs (ngsw + /sw.js separes) il y avait une race d'inscription : sur
 * iPhone PWA, ngsw gagnait souvent et notre handler push (avec setAppBadge)
 * ne tournait jamais -> badge "1" invisible.
 *
 * Avec importScripts, ngsw devient une LIBRARY interne de notre SW. Tous les
 * event listeners (push, notificationclick, fetch, message) s'additionnent :
 * quand un push arrive, ngsw affiche la notif (depuis `notification:{...}`)
 * ET notre handler additionnel set le badge.
 *
 * Dev mode : ngsw-worker.js n'est genere qu'en build de prod (cf. angular.json
 * + provideServiceWorker `enabled: !isDevMode()`). En dev, importScripts echoue
 * silencieusement et on bascule sur un push handler standalone qui appelle
 * showNotification manuellement.
 */

// ─── 1. Chargement conditionnel de ngsw-worker (prod uniquement) ───
let ngswLoaded = false;
try {
  // En prod, ngsw-worker.js est genere par Angular CLI a la racine de /dist/browser/.
  // En dev, le fichier n'existe pas et importScripts leve SyntaxError -> on continue
  // sans ngsw (notre push handler ci-dessous prendra le relais avec showNotification).
  importScripts('/ngsw-worker.js');
  ngswLoaded = true;
} catch (err) {
  // Pas de console.error : SW dev mode normal, ne pas polluer.
}

// ─── 2. Lifecycle minimal (no-op si ngsw a deja claim) ───
// Si ngsw est charge, il gere deja install/activate avec skipWaiting + clients.claim.
// On ajoute notre propre listener pour le mode standalone (dev sans ngsw).
self.addEventListener('install', () => {
  if (!ngswLoaded) self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  if (!ngswLoaded) event.waitUntil(self.clients.claim());
});

// ─── 3. Push handler ───
//
// IMPORTANT : si ngsw est charge, il a deja un push listener qui :
//   - parse event.data.json()
//   - lit le champ `notification` du payload
//   - appelle self.registration.showNotification(notification.title, notification)
//   - dispatche {type:'PUSH'} aux clients via postMessage
//
// Notre listener additionnel s'execute EN PLUS (les listeners SW sont additifs,
// pas exclusifs). On NE refait PAS showNotification si ngsw l'a deja fait :
// cela creerait un double-affichage. On se contente de :
//   - setAppBadge (que ngsw ne fait pas)
//   - notifyClients PUSH_RECEIVED (notre custom message pour la cloche
//     d'alertes — distinct du {type:'PUSH'} de ngsw qui sert SwPush.messages$)
//
// En dev (ngsw absent), notre handler doit aussi showNotification manuellement
// car personne d'autre ne le fera.
self.addEventListener('push', (event) => {
  let payload = { title: 'Vizyo Tracky', body: '', url: '/', severity: 'INFO' };
  try {
    if (event.data) {
      payload = Object.assign(payload, event.data.json());
    }
  } catch {
    // Payload non-JSON, on garde les defauts pour ne pas crasher.
  }

  const isCritical = payload.severity === 'CRITICAL';
  const appBadge = payload.appBadge;

  const tasks = [
    updateAppBadge(appBadge),
    notifyClients({ type: 'PUSH_RECEIVED', payload }),
  ];

  // En dev (sans ngsw), on doit afficher la notif manuellement.
  // En prod, ngsw l'a deja fait -> on skip pour eviter le double rendu.
  if (!ngswLoaded) {
    const options = {
      body: payload.body,
      icon: payload.icon || '/pwa-icon-192.png',
      badge: payload.badge || '/notification-badge-96.png',
      data: {
        url: payload.url || '/',
        alertId: payload.data && payload.data.alertId,
        severity: payload.severity,
        ...(payload.data || {}),
      },
      requireInteraction: isCritical,
      vibrate: isCritical ? [200, 100, 200, 100, 200] : [100],
      tag: payload.tag,
      renotify: isCritical && !!payload.tag,
      actions: [
        { action: 'ack', title: 'Acquitter' },
        { action: 'view', title: 'Voir' },
      ],
    };
    tasks.push(self.registration.showNotification(payload.title, options));
  }

  event.waitUntil(Promise.all(tasks));
});

/**
 * Met a jour l'app badge si la Badge API est disponible.
 * Try/catch obligatoire : un throw ici tuerait event.waitUntil entier et
 * iOS pourrait auto-unsubscribe (3-strikes rule sur les push events qui
 * echouent).
 *
 * Support 2026 :
 *   - iOS 16.4+ standalone PWA : oui, depuis le SW context
 *   - Chrome desktop / Edge : oui
 *   - Chrome Android : oui mais badge invisible sur home screen (le compteur
 *     fonctionne, juste pas affiche par Android jusqu'a 2027 probable)
 *   - Firefox / Safari non-PWA : silencieusement ignore
 */
async function updateAppBadge(count) {
  try {
    if (typeof self.navigator === 'undefined' || !('setAppBadge' in self.navigator)) return;
    if (count === null) {
      await self.navigator.clearAppBadge();
    } else if (typeof count === 'number' && count > 0) {
      await self.navigator.setAppBadge(count);
    }
    // count === undefined / 0 -> no-op (laisse l'etat actuel)
  } catch {/* feature absente ou contexte sans permission */}
}

// ─── 4. NotificationClick : Acquitter / Voir ───
//
// ngsw a son propre notificationclick qui dispatche aux clients via
// SwPush.notificationClicks$ et openWindow si aucun client. On ajoute notre
// logique custom EN PLUS pour gerer l'action 'ack' qui necessite un POST
// authentifie /api/alerts/:id/acknowledge.
//
// Pour 'view' et clic body : on laisse ngsw faire (ouverture/focus de la
// fenetre cible). Notre handler `ack` ne court-circuite pas, juste ajoute
// le postMessage ACK_ALERT.
self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  const data = event.notification.data || {};
  const alertId = data.alertId;

  // Ne pas closer la notif ici si action !== 'ack' : on laisse ngsw le faire
  // pour eviter une race avec son handler. Pour 'ack', on close explicitement
  // car ngsw ne sait pas que c'est traite.
  if (action === 'ack' && alertId) {
    event.notification.close();
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = pickClient(clients);
      if (target) {
        // Client ouvert -> il fera le POST avec son JWT.
        target.postMessage({ type: 'ACK_ALERT', alertId });
        if ('focus' in target) await target.focus();
        return;
      }
      // Aucun client -> on ouvre l'app sur la page alertes avec un query param
      // que NotificationsApiService.installSwMessageBridge lira au boot.
      if (self.clients.openWindow) {
        await self.clients.openWindow(`/alerts?ack=${encodeURIComponent(alertId)}`);
      }
    })());
    return;
  }

  // Pour action='view' ou clic body : si ngsw est charge, il s'en charge.
  // Sinon (dev), on fait nous-meme : focus client ou openWindow.
  if (ngswLoaded) return;

  event.notification.close();
  const targetUrl = data.url || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          try { await client.navigate(targetUrl); } catch {/* ignore */}
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

// ─── Helpers ───

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
      try { client.postMessage(message); } catch {/* ignore */}
    }
  } catch {/* ignore */}
}
