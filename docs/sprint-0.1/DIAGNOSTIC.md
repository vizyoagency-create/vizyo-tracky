# Sprint 0.1 — DIAGNOSTIC : Maps live + statut trackers

> Environnement d'analyse : **LOCAL** (poste de dev). Les chiffres `14 / 8 / 11` et le
> bandeau « interrompue » sont des observations **PROD** (captures fournies). La prod
> tourne derrière Traefik avec un VPS **CPU-bound à 100 %** (cf. Sprint 0.2). Ce
> document conclut, pour chaque symptôme, sur la **cause réelle dans le code** et sur
> le **partage applicatif vs infra (0.2)**.

Méthode : lecture du code réel (aucune solution présumée), recoupement git, et
vérification des invariants par grep exhaustif. Les renvois sont au format
`fichier:ligne`.

Stack confirmée : **API** NestJS 11 + Socket.IO 4.8.3 (`@socket.io/redis-adapter`) +
Prisma 6.19 ; **Web** Angular 20 + `socket.io-client` 4.8.3 + maplibre-gl. Front
proxy prod = **Traefik** (pas le nginx web, qui ne sert que le statique).

---

## ⚠️ MISE À JOUR — Validation sur la PROD (2026-06-13)

> Inspection read-only du VPS (SSH + DB + logs + tests WS en direct). **Une
> conclusion de l'analyse statique initiale était FAUSSE** et a été corrigée ici.

**Correction majeure (symptôme 3).** L'analyse locale disait « `Tracker.status`
n'est jamais remis OFFLINE, statut collant ». **FAUX** — c'était un **faux négatif**
de grep (motif `!(*.spec)` non supporté par ripgrep → 0 fichier scanné). Le vrai
modèle (prod ET local, code identique) : le statut est **basé sur la connexion
TCP** — [`tracker-tcp/tcp-server.service.ts`](../../apps/api/src/tracker-tcp/tcp-server.service.ts)
écrit `OFFLINE` sur `socket 'close'` et `ONLINE` au login/trame. Le vrai bug
offline = **flapping** : les boîtiers Coban rouvrent leur TCP en permanence et
chaque fermeture flippe OFFLINE **sans délai de grâce**, amplifié par la
saturation CPU.

**Preuves prod :**
- VPS **2 vCPU**, **load ~13**, **~15 stacks** partagés. `tracky-api` **0 redémarrage**,
  up 2 j (→ l'hypothèse « restart conteneur » du brief est **infirmée**).
- DB : `total=14`, `status_online=8`, `has_last_position=11` (= « 11 actif »), `never_seen=3`. ✔ matche les captures.
- Par tracker : `EP 047 TY` **OFFLINE mais lastSeenAt 0 min** (faux-offline, socket fermé mid-reconnexion) ; `FL 787 KV` (8 j), `FV 941 LZ` (45 j), `KSR 370`/`GR 898`/`GS 187` (jamais vus) = **offline réels** (= pb d'installation, attendu).
- Logs : **6 close / 5 reconnect / 0 timeout en 20 min** → churn TCP réel.
- WS via Traefik : polling **HTTP 200**, upgrade WS **HTTP 101** (donc **le proxy/WS marche**) mais **~15 s** ; `/api/health` **200 en 3,1 s** → **latence pure de CPU saturé**, pas un bug proxy.

## TL;DR (3 symptômes, 3 causes — version validée prod)

| # | Symptôme | Cause racine (validée) | Côté | Certitude |
|---|----------|--------------|------|-----------|
| 1 | Bandeau « temps réel interrompu » | API CPU-affamée → handshake WS ~15 s / ping-timeouts → socket tombe ; client **websocket-first sans repli polling** → coupure totale (le polling, lui, répond en 200). | **Infra (0.2)** + durcissement applicatif | Élevée (preuve directe) |
| 2 | Comptage 14 / 8 / 11 | **3 métriques différentes** : total / `status` (connexion TCP, flappe) / véhicules avec dernière position. Aucune n'est un vrai « live » cohérent. | **Applicatif** | Élevée |
| 3 | Trackers « offline » à tort | Statut lié au **cycle de vie du socket TCP** : `close` → OFFLINE **immédiat** (aucune grâce). Reconnexions GPRS Coban + CPU saturé → **flapping**. `EP 047 TY` = live mais affiché offline. | **Applicatif (flapping)** + **infra (0.2)** | Élevée (preuve directe) |

Live ET offline sont **deux conséquences de la saturation CPU** du VPS partagé. Les
correctifs applicatifs **durcissent** (live → repli polling ; offline → affichage par
fraîcheur + délai de grâce TCP) **sans masquer l'infra**. Levier durable = soulager le
CPU (0.2).

---

## Symptôme 1 — Live carte : bandeau « interrompue » persistant

### Ce qui pilote le bandeau (point exact)
`apps/web/src/app/features/map/map.component.ts:788`
```html
@if (!realtime.connected()) { … Connexion temps réel interrompue… }
```
Le bandeau est piloté **directement** par le signal `realtime.connected()`, lui-même mis
à `true` sur l'évènement socket `connect` et `false` sur `disconnect`
(`apps/web/src/app/core/services/realtime.service.ts:138` et `:143`).

**Conséquence importante** : le bandeau ne dépend PAS d'une heuristique « pas de trame
depuis X s » ; il reflète l'**état réel de la connexion Socket.IO**. Quand il s'affiche,
le client se croit *vraiment* déconnecté (pas juste « données figées »).

### Pourquoi le socket ne se rétablit pas (analyse)
Le client est configuré ainsi (`realtime.service.ts:131-135`) :
```ts
this.socket = io('/realtime', {
  auth: { token },
  transports: ['websocket', 'polling'],  // ← websocket d'ABORD
  reconnection: true,
});
```
1. **`socket.io-client` 4.8.3** (vérifié dans `node_modules`) introduit l'option
   `tryAllTransports` (défaut **`false`**). Avec `transports: ['websocket','polling']`
   et `tryAllTransports` non fixé, **si le handshake WebSocket échoue, le client ne
   bascule PAS sur le polling** : il émet `connect_error` et retente… encore en
   WebSocket. Le repli HTTP long-polling (qui passe partout, même proxy capricieux)
   n'est jamais tenté. C'est l'inverse du défaut robuste de Socket.IO (polling-first
   puis upgrade). Ce choix existe **depuis le tout premier commit** (`533a455`) — ce
   n'est donc PAS une régression récente, mais une fragilité latente.
2. **Auth à la connexion = requête DB.** `RealtimeGateway.handleConnection`
   (`apps/api/src/realtime/realtime.gateway.ts:32-57`) fait `verifyAccessToken` (JWT pur)
   **puis** `resolveLocalUser` → `prisma.user.findUnique` (`apps/api/src/auth/auth.service.ts:78-85`).
   Sous CPU saturé / pool DB sous tension (0.2), cette requête peut être lente ou
   échouer → `client.disconnect()` (`realtime.gateway.ts:55`) → `connect_error` côté
   client → **chaque tentative de reconnexion échoue** tant que l'API rame.
3. **Logique de reconnexion applicative = correcte.** Le commit `85ac5f7`
   (« reconnexion WS ») a ajouté le refresh JWT sur `connect_error`
   (`realtime.service.ts:148-159`) + refresh proactif au refocus
   (`:80-88`). C'est sain : une fois l'API revenue, le socket *devrait* se reconnecter
   tout seul. Donc la **non-reconnexion n'est pas un bug de logique** mais une
   conséquence de l'environnement (API injoignable/rejette) + l'absence de repli polling.

### Passage par le reverse proxy
- Le routage est correct : Traefik capte `/api`, `/realtime` **et** `/socket.io`
  (`deploy/vps/docker-compose.prod.yml:90`) → API:3000. Traefik gère l'upgrade
  WebSocket **nativement**. Donc l'upgrade WS n'est PAS bloqué structurellement.
- ⚠️ **Anomalie config** : le middleware `tracky-api-ws`
  (`X-Forwarded-Proto=https`) est **défini** (`docker-compose.prod.yml:97`) mais
  **jamais attaché** au routeur (pas de `routers.tracky-api.middlewares=…`). Impact
  faible sur l'upgrade lui-même (Traefik upgrade quand même), mais à corriger pour la
  propreté (protocole d'origine vu par le backend). Certitude moyenne sur l'impact.
- Le `nginx.web.conf` ne proxifie **rien** (`/api`/`/realtime` tomberaient sur le
  fallback SPA) — c'est normal ici car Traefik intercepte **avant** le conteneur web
  grâce aux priorités de routeur (API priorité 10 > web priorité 1).

### Point de rupture confirmé
> Le bandeau s'affiche parce que le **socket WS est réellement déconnecté** et que les
> tentatives de reconnexion **échouent en continu**. La cause déclenchante est
> **infra (0.2)** : redémarrages/saturation CPU de l'API → handshake WS et/ou auth DB à
> la connexion qui échouent. La **fragilité applicative aggravante** est le transport
> `websocket`-first **sans repli `polling`** (pas de `tryAllTransports`), qui supprime
> le mode dégradé qui aurait gardé le live vivant pendant les à-coups.

**Attribution : principalement 0.2 (infra). Durcissement applicatif possible et utile
(repli polling) — sans masquer l'infra.** À revérifier : une fois le CPU redescendu,
le live revient-il seul ? (attendu : oui, la logique de reconnexion est saine).

Certitude : **élevée** sur le mécanisme du bandeau et le rôle du transport ;
**moyenne-élevée** sur l'attribution infra exacte (non rejouable en local sans la
saturation CPU prod).

---

## Symptôme 2 — Comptage incohérent (14 / 8 / 11)

Les trois nombres viennent de **trois sources et trois définitions différentes**. Ce
ne sont PAS trois mesures de la même grandeur.

### 14 = total trackers (admin)
`apps/web/src/app/features/observability/admin-trackers.component.ts:294-302`
→ `summary().total = trackers().length`. Données via `GET /api/trackers?limit=500`
(`trackers.service.findAll`, `apps/api/src/trackers/trackers.service.ts:101-106`) qui
renvoie les lignes `Tracker` (scope super-admin = toutes flottes). **14 trackers en
base.** `unassigned = 0` → les 14 sont tous rattachés à un véhicule.

### 8 = `status === 'ONLINE'` (admin)
Même composant : `online = all.filter(t => t.status === 'ONLINE').length`
(`admin-trackers.component.ts:298`). C'est la **colonne `status` stockée** renvoyée
telle quelle par l'API — voir Symptôme 3 : cette colonne est **collante** (jamais
remise à OFFLINE). Donc « 8 online » = « 8 trackers ont déjà émis au moins une trame un
jour », **pas** « 8 sont live maintenant ».

### 11 = « actif(s) » (carte)
`apps/web/src/app/features/map/map.component.ts:2056-2061`
```ts
filteredPositionCount = computed(() => this.realtime.positionsList().length …)
```
`positionsList` = valeurs du signal `positions`, peuplé par l'**hydratation REST**
`GET /api/vehicles/snapshot` (`realtime.service.ts:334-386`). Le filtre d'hydratation
n'ajoute un véhicule que s'il a `trackerId && lastLat && lastLng && lastPositionAt`
non-nuls (`realtime.service.ts:345-357`). Donc **« 11 actif » = 11 véhicules ayant une
dernière position connue (dénormalisée), peu importe sa fraîcheur**. C'est insensible à
la coupure realtime — d'où un compteur **figé** affiché À CÔTÉ du bandeau « interrompue ».

> Le libellé **« actif(s) » est trompeur** : il signifie « a une dernière position
> connue », pas « live ».

### Pourquoi 11 > 8 (le paradoxe) — résolu
En ingestion, `lastLat/lastLng/lastPositionAt` ET `status:'ONLINE'` sont écrits **dans
le même `tracker.update`** (`positions.service.ts:174-204`). Donc *normalement*
`lastLat ≠ null ⟹ status = ONLINE`, et on devrait avoir `online ≥ carte`. Le fait que
`8 < 11` s'explique par la **migration de backfill**
`apps/api/prisma/migrations/20260426120000_tracker_last_position_denorm/migration.sql` :
elle a rempli `lastLat/lastLng/lastPositionAt` depuis la table `positions` **sans
toucher `status`**. Un tracker ayant des positions historiques mais resté `status =
OFFLINE` (défaut, jamais repassé ONLINE) se retrouve donc **visible sur la carte (a une
dernière position) mais compté OFFLINE en admin**. Les deux compteurs sont **découplés**.

### Conclusion
Aucun des trois nombres n'est un compteur « live » correct. La carte (11) et l'admin
(8) divergent **par construction** (définitions + backfill + statut collant). Le vrai
correctif est de **définir une liveness unique basée sur la fraîcheur** et de l'utiliser
partout (admin, carte, snapshot). **Applicatif, indépendant de 0.2.**

Certitude : **élevée** sur les définitions/sources ; l'arithmétique exacte du trio
prod (qui est OFFLINE-mais-avec-position) demande une requête sur la base prod
(procédure fournie dans PLAN).

---

## Symptôme 3 — Trackers « offline » à tort

### Le fait central (invariant vérifié par grep)
**Aucune ligne de code applicatif n'écrit jamais `status: 'OFFLINE'` (ni `IDLE`).**
- `enum TrackerStatus { ONLINE, OFFLINE, IDLE }`, défaut **`OFFLINE`**
  (`apps/api/prisma/schema.prisma:19-22`, `:350`).
- Seule écriture de `status` dans tout le code applicatif : `status: 'ONLINE'` à
  l'ingestion (`apps/api/src/positions/positions.service.ts:128` et `:176`).
- Grep exhaustif (hors `*.spec.ts`) de `status:'OFFLINE'|'IDLE'`, `TrackerStatus.OFFLINE`,
  `$executeRaw/$queryRaw` sur trackers, et des seeds → **0 résultat**. Aucun cron/sweep
  ne remet un tracker offline.

> **`Tracker.status` n'est donc PAS un indicateur temps réel.** C'est un drapeau
> **collant** : `OFFLINE` jusqu'à la 1ʳᵉ trame ingérée, puis `ONLINE` **pour toujours**.
> « 6 offline » = « 6 trackers n'ont jamais réussi à ingérer une trame » (ou jamais
> repassés ONLINE depuis le backfill).

### Conséquences
1. **Un tracker réellement hors-ligne reste `ONLINE`** indéfiniment (jamais remis
   offline). Donc un vrai offline n'est *pas* détecté par cette colonne.
2. **Un tracker `OFFLINE` en admin l'est car ses trames n'arrivent pas jusqu'à
   `ingest()`** — pas parce qu'il est « périmé ». Causes possibles, à trancher avec
   preuve :
   - **IMEI inconnu** : `ingest()` jette tôt si l'IMEI n'est pas en base
     (`positions.service.ts:57-60`) → `status` reste au défaut OFFLINE.
   - **Trames toutes invalides / Null Island** : `isValidLatLng` rejette **avant toute
     mise à jour de liveness** (`positions.service.ts:88-94`, `return` ligne 93 AVANT le
     `tracker.update`). ⚠️ Asymétrie notable : la garde **anti-replay**, elle, met bien
     à jour la liveness avant de sortir (`:124-129`). Donc un boîtier qui communique
     mais n'a **que** des fixes invalides (démarrage à froid, indoor) **n'apparaît
     jamais "vu"** (ni `lastSeenAt`, ni `ONLINE`). C'est un **faux-offline applicatif**.
   - **TCP non reçu** (SIM/APN/réseau) ou **serveur TCP saturé/redémarré** → trames
     jamais reçues : **faux-offline d'origine infra (0.2)** si l'ingestion est en
     backlog.

### Faux-offline vs offline réel — comment trancher (preuve)
La colonne `status` ne suffit pas. La preuve se lit sur **`lastSeenAt` / `lastPositionAt`
vs maintenant** et le **nombre de positions récentes** :
- `status=OFFLINE` **et** `lastSeenAt = null` → **jamais vu** (offline réel ou IMEI/SIM
  jamais arrivés). Ex. attendus utilisateur : **FL, KSR370, FV**.
- `status=OFFLINE` **mais** `lastSeenAt` récent OU positions récentes → **faux-offline**
  (statut collant + asymétrie invalid-frame). Cas suspect des trackers **flotte CDEF**.
- `status=ONLINE` **mais** `lastSeenAt` ancien (> seuil) → **faux-online** (offline réel
  masqué par le statut collant).

Requête de preuve (à lancer en prod, fournie dans PLAN.md) qui sort, par tracker :
`status`, `lastSeenAt`, `lastPositionAt`, et `count(positions sur 1 h)`.

### Le seul endroit où la fraîcheur est utilisée
`apps/api/src/tracker-fix-mode/admin-alerts.controller.ts:86-94` liste les offline du
hub d'observabilité avec `status:'OFFLINE' AND (lastSeenAt < cutoff OR null)`. Mais
c'est de l'**affichage** (hub admin), pas une écriture de statut, et ça hérite du même
biais (un vrai offline `status=ONLINE` n'y apparaît jamais).

### Attribution
**Modèle offline cassé = applicatif** (pas de transition offline, asymétrie invalid).
Les **faux-offline réellement dus au backlog d'ingestion** (CPU saturé) = **infra (0.2)**.
Le correctif applicatif (liveness par fraîcheur) est **indépendant de 0.2** et nécessaire
pour que l'UI dise la vérité même infra saine.

Certitude : **élevée** (invariant prouvé par grep + lecture ligne à ligne).

---

## Symptôme annexe — Cloche saturée (50+)

Non bloquant pour la DoD, mais expliqué :
- En **dev** (`MOCK_POSITIONS=true`), `MockPositionEmitterService` injecte des alarmes
  aléatoires à chaque tick de 2 s (`mock-position-emitter.service.ts:223-227`,
  ~2,3 % warning / 0,3 % critical par tick par tracker). Sur quelques minutes →
  dizaines d'alertes. La cloche charge `acknowledged=false&limit=50`
  (`realtime.service.ts:388-399`) → plafond d'affichage **50**.
- En **prod**, même plafond : ≥ 50 alertes **non acquittées** accumulées (overspeed,
  géofence, etc.). La coupure realtime n'en crée pas de nouvelles côté WS, mais le
  backlog s'affiche au chargement REST.
- Piste de fond (hors-scope 0.1) : absence d'auto-résolution/dédup des alertes
  récurrentes (ex. offline/overspeed persistant). À renvoyer en suivi.

---

## Régression récente ? (recoupement git)
- `transports: ['websocket','polling']` : présent **depuis l'origine** (`533a455`) → pas
  une régression, mais fragilité latente (cf. Symptôme 1).
- `c970a04` / V1.17 « garde-fou ingestion anti-replay » : la garde **conserve la
  liveness** (`positions.service.ts:124-129`) et n'affecte **ni** le statut **ni** les
  faux-offline. Logique `evaluateIngestionFix` saine (`packages/shared/src/utils/gps-sanity.ts:111-137`),
  utilise le `dt` plein pour ne pas perdre un rattrapage légitime. **Seul** risque
  résiduel : un boîtier à **horloge dans le futur** ferait rejeter toutes ses trames
  réelles ensuite (`dtSec <= 0`) → live figé pour CE véhicule (statut/lastSeen restent
  OK). Cas étroit, **faible probabilité**, à garder en tête.
- `85ac5f7` « reconnexion WS » : amélioration saine, pas une régression.

**Aucune régression récente n'explique le bandeau** : il s'agit d'infra (0.2) + fragilité
de transport d'origine.

---

## Synthèse pour le PLAN
| Cible | Correctif | Côté | Risque |
|-------|-----------|------|--------|
| Live transport | Repli `polling` (`tryAllTransports:true` ou polling-first) | App | Faible |
| Live infra | Stabiliser CPU/redémarrages, vérifier retour auto | **0.2** | — |
| Comptage + offline | **Liveness par fraîcheur** unique (helper partagé) utilisée en admin + carte + snapshot | App | Moyen (change des nombres affichés) |
| Faux-offline invalid | Mettre à jour la liveness **avant** la garde `isValidLatLng` | App | Faible-moyen |
| Traefik WS middleware | Attacher `tracky-api-ws` au routeur | Infra/config | Faible |
| Cloche | Auto-résolution/dédup alertes | App (suivi) | Hors-scope |
