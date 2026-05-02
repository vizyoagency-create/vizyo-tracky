# 18 — Web Push : déploiement et exploitation

> Procédure officielle pour activer / désactiver les notifications Web Push
> sur les environnements Vizyo Tracky (dev local, staging, prod VPS).

## TL;DR

Trois variables d'environnement contrôlent l'ensemble :

```
VAPID_PUBLIC_KEY=<base64url, 88 chars>
VAPID_PRIVATE_KEY=<base64url, 43 chars>
VAPID_SUBJECT=mailto:contact@vizyoagency.com
```

Si `VAPID_PUBLIC_KEY` est vide, l'API démarre en **mode no-op** : pas de push
envoyé, pas d'erreur, l'UI affiche "Push désactivé côté serveur".

## Génération des clés VAPID

Les clés VAPID identifient votre serveur auprès des push providers (FCM, Mozilla
autopush, Apple APN). Elles sont générées **une seule fois par environnement**
puis ne doivent **jamais changer** : si elles tournent, toutes les
`PushSubscription` enregistrées deviennent invalides et chaque device doit
re-souscrire (perte silencieuse côté utilisateur).

### En local (dev)

```bash
npx web-push generate-vapid-keys --json
```

Coller dans `.env` (racine) ET dans `apps/api/.env` (l'API NestJS lit en
priorité son propre `.env`).

### En production (VPS)

Sur le VPS cible, en root ou utilisateur de service :

```bash
docker run --rm node:22-alpine npx web-push generate-vapid-keys --json
```

Sortie :

```json
{
  "publicKey": "BK_2rHL98aV-rtSPydV0e5...",
  "privateKey": "UGCfqtiMTTof87jExNWcv..."
}
```

1. Stocker `publicKey` et `privateKey` dans le **secret manager** du VPS
   (Docker secret, Vault, fichier `.env` chmod 600 hors du repo, etc.).
   **Ne jamais** committer ces valeurs.
2. Renseigner `VAPID_SUBJECT=mailto:<email contact technique>` (RFC 8292 —
   le push provider utilise cet email pour signaler tout abus).
3. Restart du conteneur API : `docker compose -f deploy/vps/docker-compose.prod.yml up -d api`
4. Vérifier les logs : la ligne `Web Push enabled (VAPID configured)` doit
   apparaître au boot. Si on voit `Web Push disabled (VAPID_PUBLIC_KEY missing)`,
   les vars n'ont pas été propagées — vérifier `docker exec api env | grep VAPID`.

### Test post-déploiement

1. Ouvrir l'app prod dans Chrome / Firefox / Edge.
2. Se connecter, aller sur **Mon compte → Notifications**.
3. Cliquer **"Activer les notifications push"** → la pop-up système doit
   demander la permission.
4. Une ligne doit apparaître dans **"Devices abonnés"** avec le User-Agent et
   le timestamp.
5. Déclencher une alerte CRITICAL (par ex. SOS depuis un tracker de test, ou
   Prisma Studio direct) → la notification système doit s'afficher dans les
   2-3 secondes, même app fermée.

## Rotation des clés (cas exceptionnel)

À éviter sauf compromission. Si nécessaire :

1. Générer un nouveau couple de clés.
2. **Avant** de déployer : préparer une communication utilisateurs ("vous
   devrez ré-activer les notifications"). Toutes les anciennes subscriptions
   retourneront 401 ou 403 et seront purgées par le auto-pruning de
   `WebPushService.sendToUser`.
3. Déployer les nouvelles clés.
4. (Optionnel) Vider la table `pushSubscription` :
   `DELETE FROM "push_subscriptions";` — propre mais pas obligatoire,
   l'auto-pruning fait le travail.

## Désactivation temporaire

Pour désactiver le push sans rotation des clés (par ex. pour debug) :

```
VAPID_PUBLIC_KEY=
```

L'API entre en mode no-op au prochain restart. Les subscriptions existantes
restent en base mais aucun push n'est envoyé. Réactiver = restaurer la valeur
+ restart.

## Domaines & HTTPS

`PushManager.subscribe()` requiert HTTPS (sauf `localhost` qui est exempté).
La prod (`https://app-tracky.vizyoagency.com`) est OK via Traefik + Let's
Encrypt. Toute préprod en HTTP simple = push inopérant côté browser.

## Browsers supportés

| Browser | Push | Vibration | Actions |
|---------|------|-----------|---------|
| Chrome desktop / Android | ✅ | ✅ Android | ✅ |
| Edge desktop | ✅ | ⚠️ ignore | ✅ |
| Firefox desktop / Android | ✅ | ✅ Android | ✅ |
| Safari macOS 16+ | ✅ | ❌ | ⚠️ partiel |
| Safari iOS | ✅ **PWA only** | ✅ via OS | ⚠️ partiel |

**Safari iOS** : Web Push fonctionne **uniquement** si l'app est installée
en PWA (Partager → Sur l'écran d'accueil). En navigation Safari classique,
la subscription échoue silencieusement. L'UI affiche le toggle quand
même — à l'utilisateur de comprendre via la banner d'install.

## Architecture (rappel)

```
[Browser] --subscribe--> [PushManager] -- <token endpoint, p256dh, auth>
                                              |
[Frontend] -- POST /api/notifications/push/subscribe --> [WebPushService.subscribe]
                                                              |
                                                          [Postgres: push_subscriptions]

[Trame Coban CRITICAL] --> [AlertsService.create]
                                |
                                +--> RealtimeGateway.broadcastAlert (WS)
                                |
                                +--> NotificationDispatchService.dispatchAlert
                                              |
                                              +--> WebPushService.sendToUser(userId, payload)
                                                          |
                                              [web-push lib] -- HTTPS --> [FCM / Mozilla / APN]
                                                                                |
                                                                       [Browser SW reçoit push]
                                                                                |
                                                                       /sw.js handler "push"
                                                                       --> showNotification(title, options)
```

## Pièges connus

1. **Régénérer les clés en cours de dev casse tous les devices** — voir
   "Rotation des clés".
2. **Service worker cached agressivement** — après modif de `apps/web/public/sw.js`,
   utiliser DevTools → Application → Service Workers → "Update on reload"
   ou cliquer "Unregister" + reload manuel.
3. **Permission `denied` est définitive** — pas de re-prompt possible dans
   Chrome sans reset manuel des permissions site (chrome://settings/content/notifications).
   L'UI doit le signaler clairement (à venir : message "Permission refusée — pour
   réactiver, cliquer le cadenas dans la barre d'URL").
4. **Autoplay audio bloqué** — le son du toast CRITICAL est pré-chargé au
   moment où l'utilisateur clique "Activer les notifications" (geste
   utilisateur récent). Si l'utilisateur n'a jamais activé le push, le 1er
   son peut être bloqué silencieusement par la policy d'autoplay du browser
   (le toast reste visible, juste pas de ping audio).
5. **`renotify: true` requiert un `tag`** — sinon le browser émet une warning
   et ignore le flag. Notre payload met `tag = alertId`, c'est OK.

## Variables d'environnement — récap

| Variable | Dev local (.env) | Prod (.env.prod) |
|----------|------------------|------------------|
| `VAPID_PUBLIC_KEY` | générée localement | secret manager |
| `VAPID_PRIVATE_KEY` | générée localement | secret manager |
| `VAPID_SUBJECT` | `mailto:contact@vizyoagency.com` | idem |

---

*Dernière mise à jour : 2026-05-02 — implémenté dans `feat/web-push-finalize`.*
