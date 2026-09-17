# Lot D — Vizyo Manager × Tracky : création d'un client en un clic, puis synchronisation (cahier de lancement, 17/09/2026)

> À lire **en premier** par la session qui prend le lot D avec le dossier du projet Manager
> (`D:\www\vizyo-agency\vizyo-manager`). Ce document est **auto-suffisant** : le contrat exact entre les deux
> applications, ce qui existe déjà côté Tracky (en production depuis le 17/09 09:10), ce qu'il reste à construire
> côté Manager puis côté Tracky, l'ordre de déploiement, la recette. Référence de conception :
> [`2026-09-16-CONCEPTION-V2-RESERVATIONS-PLANNINGS.md`](./2026-09-16-CONCEPTION-V2-RESERVATIONS-PLANNINGS.md)
> (§ 1.2 défauts C1–C11, § 2.3, § 2.5, § 3.7–3.8, § 4.4–4.6, § 8.4) ; lot A livré :
> [`2026-09-17-LOT-A-SOCLE.md`](./2026-09-17-LOT-A-SOCLE.md).

---

## 0. En une page

**Le besoin.** Un opérateur Tracky valide la demande de RDV d'un **prospect** (client sans compte). Aujourd'hui, l'écran
propose « Créer le client dans Vizyo Manager et valider » — le bouton est **câblé mais inactif** en prod : Tracky répond
`503 « La création directe dans Vizyo Manager n'est pas configurée (MANAGER_INTERNAL_URL) »` et ouvre en secours le
formulaire Manager prérempli (`/admin/clients/new?companyName=…&email=…&phone=…&tracky=1`).

**Le lot D rend ce bouton réel**, sans que Tracky crée jamais une flotte lui-même (règle de conception) :

1. **Manager expose `POST /internal/clients`** (garde HMAC existante, appli `tracky`), qui exécute **exactement** sa
   création habituelle (Vizyo Auth + Leads + Tracky + client + essai) et répond `{ clientId, trackyFleetId }`.
2. **Manager corrige ses défauts vers Tracky** (C1 `clientId` jamais envoyé, C2 prénom = nom de société, C4 client
   « Tracky activé » sans flotte irréparable, C5 essai Leads automatique pour tout le monde).
3. **Synchronisation Manager → Tracky** (C10 : renommer un client ne renomme pas la flotte ; C11 : réactivation jamais
   propagée, désactivation partielle) — nouvelles routes internes Tracky en HMAC (C7), archivage (Q12), « Resynchroniser »,
   « Adopter une flotte Tracky existante ».
4. **Prod** : `INTERNAL_ALLOWED_APPS += tracky` et `VIZYO_TRACKY_APP_SECRET` côté Manager ; `MANAGER_INTERNAL_URL` côté
   Tracky. Le bouton devient un clic.

**Deux dépôts, deux sessions** : la session Manager (celle qui lit ceci) fait **§ 3** (Manager) ; la session Tracky a
**déjà fait § 4** (routes internes, HMAC entrant à double acceptation, archivage, effacement — branche
`feat/rdv-lot-d-tracky`, non déployée au moment d'écrire). **Ordre de déploiement : § 6**.

---

## 1. Ce qui existe déjà (Tracky, en production)

### 1.1 L'appel sortant Tracky → Manager (`apps/api/src/installation-booking/manager-client.service.ts`)
Appelé à la validation d'une demande sans flotte quand l'opérateur clique « Créer le client dans Vizyo Manager ».

```
POST {MANAGER_INTERNAL_URL}/internal/clients
Content-Type: application/json
X-App-Id: tracky
X-App-Timestamp: <secondes UNIX>
X-App-Signature: HMAC-SHA256( VIZYO_AUTH_APP_SECRET_de_Tracky , `${timestamp}.${JSON.stringify(body)}` ) en hex

body (clés DANS CET ORDRE, les `undefined` absents) :
{
  "companyName": "Garage Martin",
  "email": "marc@legrand.fr",             ← e-mail de connexion du client (= admin de la flotte)
  "notificationEmail": "marc@legrand.fr",
  "contactFirstName": "Marc",              ← facultatif (absent si inconnu)
  "contactLastName": "Legrand",            ← facultatif
  "phone": "+33612345678",                 ← facultatif, E.164
  "trackyEnabled": true,
  "trackyFleetName": "Garage Martin",
  "origin": "tracky-rdv",
  "externalRef": "<id de la demande Tracky>"
}
```
Délai 20 s. Réponse attendue **2xx** avec `{ "clientId": "<id client Manager>", "trackyFleetId": "<uuid flotte Tracky>" }`.
Toute autre forme (pas de `trackyFleetId`) → Tracky refuse de rattacher et le dit (« Manager a créé le client mais n'a pas
renvoyé de flotte ») ; erreur 4xx/5xx → le `message` du corps est montré à l'opérateur ; injoignable → 503 « Vizyo
Manager ne répond pas ». Rien n'est créé côté Tracky tant que Manager n'a pas répondu proprement — **jamais de demi-client**.

⚠️ **Le secret** : Tracky signe avec **`VIZYO_AUTH_APP_SECRET`** (le secret de l'application *Tracky* dans Vizyo Auth).
Manager le connaît déjà sous **`VIZYO_TRACKY_APP_SECRET`** (`src/config/configuration.ts` : `trackyAppSecret`). La garde
lit `VIZYO_<APPID>_APP_SECRET` avec `appId = tracky` → `VIZYO_TRACKY_APP_SECRET`. **Aucun nouveau secret à distribuer** —
vérifier en prod que les deux valeurs sont bien identiques (c'est le même enregistrement Vizyo Auth).

### 1.2 Le point d'entrée entrant de Tracky, déjà corrigé (C1–C3)
`POST {TRACKY}/api/internal/fleet/provision` (garde `X-Internal-Secret`, inchangée pour l'instant) :
```
{ fleetName, clientId?, adminAuthUserId, adminEmail, adminFirstName?, adminLastName?, adminPhone? }
→ 201 { fleetId, existed: false }         nouvelle flotte + admin FLEET_ADMIN, en UNE transaction
→ 201 { fleetId, existed: true }          admin déjà connu (même e-mail OU même authUserId) : SA flotte est rendue,
                                          rien n'est créé, `clientId` recollé si fourni (IDEMPOTENT — rejouable)
→ 409                                     compte connu SANS flotte : à rattacher à la main
```
`adminPhone` accepte E.164 ou national français (`06 12 34 56 78` → `+33612345678`). Manager lit `body.fleetId` : compatible.
⚠️ En cas d'erreur, le corps de Tracky est `{ "error": { "code", "message", "requestId" } }` (filtre global) — le client HTTP
de Manager lit `body.message`, qui est **absent** : lire `body.error?.message ?? body.message`.

### 1.3 Ce que Tracky affiche en attendant
`GET /api/installation-bookings/:id/confirm` sans flotte → `409 { error: { code: 'SANS_FLOTTE', creationManagerConfiguree,
urlManager } }` ; `urlManager` = `{MANAGER_WEB_URL}/admin/clients/new?companyName=&email=&tracky=1[&phone=]`
(`MANAGER_WEB_URL` défaut `https://manager.vizyoagency.com`). **Le formulaire Manager ne lit pas encore ces paramètres**
(§ 3.6).

---

## 2. Les défauts à corriger, avec leur preuve (rappel du § 1.2 de la conception)

| # | Où | Défaut | Correction (lot D) |
|---|---|---|---|
| C1 | Manager → Tracky | `provisionTrackyFleet()` accepte `clientId?` mais `create()` ne le passe jamais (vide sur les 5 flottes de prod) | envoyer `clientId` (création **et** `activateTracky`) |
| C2 | Manager → Tracky | `adminFirstName: dto.companyName`, pas de nom, pas de téléphone (prod : « Administeur / A2R ») | champs de **contact** sur `Client` + formulaire, envoyés à Tracky |
| C4 | Manager | client `trackyEnabled` sans `trackyFleetId` (provision échouée) → « already enabled », irréparable | `activateTracky()` reprovisionne ce cas (Tracky est idempotent : sûr) |
| C5 | Manager | `autoTrialApps = ['LEADS']` pour tout client, même Tracky seul | essai selon les apps réellement activées |
| C7 | Tracky ← Manager | Tracky entrant = secret statique ; Manager entrant = HMAC + horodatage | Tracky passe au HMAC (§ 4.2) ; le client HTTP Manager → Tracky signe |
| C10 | Manager | `update()` synchronise Leads, pas Tracky | `syncClientToTracky()` (§ 4.1) |
| C11 | Manager | `activateTrackyFleet()` jamais appelé ; `deactivate()` ne suspend que l'admin | réactivation symétrique, flotte entière |

---

## 3. Côté Manager (`vizyo-manager-api` + `vizyo-manager-dashboard`) — ce que fait la session Manager

Repères lus le 16/09 (HEAD `283ee2e`) : garde `src/common/guards/internal-hmac.guard.ts` (en-têtes `X-App-Id`,
`X-App-Timestamp` ±300 s, `X-App-Signature` = HMAC-SHA256 sur `${ts}.${JSON.stringify(req.body)}`, secret
`VIZYO_<APPID>_APP_SECRET`, applis `INTERNAL_ALLOWED_APPS`, défaut `leads`) ; exemple d'usage
`src/subscriptions/subscriptions-internal.controller.ts` ; `src/clients/clients.service.ts` (`create`, `update`,
`activateTracky`, `deactivate`, `provisionTrackyFleet` avec `X-Internal-Secret` vers `vizyo.trackyInternalUrl`, défaut
`http://vizyo-tracky-api:3000`) ; DTO `src/clients/dto/create-client.dto.ts` ; `main.ts` : `ValidationPipe({ whitelist:
true, forbidNonWhitelisted: true, transform: true })` ; dashboard route `admin/clients/new` (`app.routes.ts:80`).

### 3.1 `POST /internal/clients` (nouveau)
- Contrôleur `src/clients/clients-internal.controller.ts`, `@Controller('internal/clients')`, `@UseGuards(InternalHmacGuard)`.
- DTO `InternalCreateClientDto` : **toutes** les clés du § 1.1 (`companyName`, `email`, `notificationEmail`,
  `contactFirstName?`, `contactLastName?`, `phone?`, `trackyEnabled`, `trackyFleetName`, `origin`, `externalRef`).
  ⚠️ `forbidNonWhitelisted: true` : une clé non déclarée = 400. ⚠️ La garde vérifie la signature sur `req.body` **avant**
  la pipe (ordre Nest : guards → pipes) : ne rien faire qui réécrive le corps avant la garde (pas de middleware qui
  le transforme).
- Appelle `clients.create()` (le même chemin que l'écran), avec `origin`/`externalRef` journalisés sur le client
  (colonnes `origin String?`, `externalRef String?` — utile pour retrouver la demande Tracky).
- Répond `201 { clientId, trackyFleetId }`. Si la provision Tracky a échoué **après** la création du client, répondre
  `503 { message }` explicite (Tracky l'affiche) et laisser le client réparable (C4).
- `INTERNAL_ALLOWED_APPS=leads,tracky` (défaut du code à mettre à jour aussi).
- Tests : signature valide → 201 et `create()` appelé avec les bons champs ; signature fausse / horodatage périmé / appli
  non autorisée → 401 ; clé inconnue → 400 ; provision Tracky en échec → 503 avec message.

### 3.2 C1 + C2 — contact et `clientId` envoyés à Tracky
- `Client` : `contactFirstName String?`, `contactLastName String?`, `phone String?` (migration Prisma **rejouée** avant push).
- `provisionTrackyFleet({ fleetName, clientId, adminAuthUserId, adminEmail, adminFirstName: contactFirstName,
  adminLastName: contactLastName, adminPhone: phone })` — depuis `create()` **et** `activateTracky()`.
- Formulaire dashboard « Nouveau client » et fiche client : prénom, nom, téléphone du contact.

### 3.3 C4 — `activateTracky()` répare un client sans flotte
Si `trackyEnabled && !trackyFleetId` → reprovisionner (Tracky rend `existed: true` si l'admin existe déjà : pas de doublon).

### 3.4 C5 — essai automatique selon les apps
`autoTrialApps` dérivé des apps activées à la création (Tracky seul ⇒ pas d'essai Leads).

### 3.5 Synchronisation sortante `syncClientToTracky()` (C10, C11) — **dépend du § 4 Tracky**
- `update()` : `PATCH {TRACKY}/api/internal/fleet/:trackyFleetId` `{ name?, contact?: { firstName, lastName, phone },
  notificationEmail?, adminEmail? }` — `adminEmail` **seulement** après acceptation par Vizyo Auth (l'e-mail est
  l'identifiant d'Auth : Manager change Auth d'abord, puis pousse).
- `deactivate()` / `activate()` : `POST fleet/suspend` / `fleet/activate` (existants) — la **flotte entière**.
- `archive()` / `unarchive()` / `destroy()` (Q12) : `POST fleet/:id/archive` · `unarchive` · `DELETE fleet/:id`.
- « Resynchroniser » (fiche client) : `PUT fleet/:id` (état complet, idempotent). « Adopter une flotte Tracky
  existante » : `GET fleets?unlinked=true` puis `PUT` avec `clientId`.
- **Jamais silencieux** : échec → `trackySyncFailedAt` + `trackySyncError` sur le client, visibles sur la fiche, bouton
  « Resynchroniser ». Le client HTTP Manager → Tracky **signe en HMAC** (même schéma que la garde, appli `manager`,
  secret `VIZYO_MANAGER_APP_SECRET` déjà présent dans `configuration.ts`) — voir § 4.2 pour la transition.

### 3.6 Dashboard : `admin/clients/new` prérempli
Lire `companyName`, `email`, `phone`, `tracky=1` dans les query params (c'est le secours que Tracky ouvre) ; cocher
« Tracky » quand `tracky=1`.

---

## 4. Côté Tracky — FAIT le 17/09 (branche `feat/rdv-lot-d-tracky`), contrat des routes pour Manager

### 4.1 Routes internes (`apps/api/src/internal/`, service `FleetSyncService`)
Toutes derrière la garde du § 4.2. Corps JSON ; réponses d'erreur `{ error: { code, message, requestId } }`.

| Route | Corps | Réponse | Effet |
|---|---|---|---|
| `GET fleets?unlinked=true` | — | `[{ id, name, adminEmail, fleetId, createdAt, vehicles, users, admins:[{email,name}] }]` | flottes sans `clientId`, non archivées (« Adopter ») — `id` + `adminEmail` = ce que Manager lit |
| `PATCH fleet/:fleetId` | `{ name?, contact?: { firstName?, lastName?, phone? }, notificationEmail?, adminEmail?, clientId? }` — n'envoyer que ce qui change ; `null` efface `phone` / `notificationEmail` | `{ fleetId, name, clientId, adminUserId, adminEmail, managedByManagerAt, changed: [...] }` | `fleet.name`, `fleet.contactPhone`, `fleet.weeklyReportEmail`, admin `firstName/lastName/phone/email` ; pose `managedByManagerAt` et marque l'admin `managedByManager` |
| `PUT fleet/:fleetId` | `{ name, clientId, contact?, notificationEmail?, isActive?, archived?, adminEmail? }` | idem + `authFailures` | état complet, idempotent (« Resynchroniser ») ; `clientId` posé si absent (« Adopter ») ; `isActive:false/true` suspend / réactive **tous** les membres, Vizyo Auth aligné (C11) ; `archived:true/false` archive / désarchive (l'archive prime sur `isActive`) |
| `POST fleet/:fleetId/archive` | `{ by? }` | `{ status:'archived', authFailures, alreadyArchived }` | `archivedAt/By`, membres suspendus (Auth aligné), liens de réservation fermés ; rejouable |
| `POST fleet/:fleetId/unarchive` | `{ by? }` | `{ status:'active', authFailures, wasArchived }` | membres réactivés (liens restent fermés) |
| `DELETE fleet/:fleetId` | — (ou `{ confirmName?, by? }`) | `{ status:'deleted', deleted:{…}, authRemoved, authFailures }` | **depuis l'archive seulement** (409 sinon) ; si `confirmName` est envoyé, il doit être le nom exact ; efface positions/trajets des boîtiers, tables à `fleetId` dénormalisé, la flotte et ses cascades ; **boîtiers et SIM dissociés, pas détruits** ; comptes retirés de l'appli Tracky dans Vizyo Auth ; journaux conservés ; 404 si déjà absente |
| `POST fleet/suspend` · `activate` | `{ fleetId }` (existants) | — | flotte entière (déjà le cas) |
| `POST fleet/provision` | (§ 1.2) | `{ fleetId, existed }` | l'admin créé est `managedByManager`, la flotte `managedByManagerAt` |

Règles : le `clientId` se pose mais ne se **réécrit jamais** (409 si différent : doublon côté Manager) ; `adminEmail`
déjà pris par un autre compte → 409 ; téléphone illisible → 409 ; flotte inconnue → 404. Chaque poussée écrit une
ligne au journal Système (catégorie `INTERNAL`, `changed`), y compris « déjà à jour ». Côté Tracky, le prénom/nom d'un
admin `managedByManager` ne se modifie plus dans l'écran Utilisateurs (409 `GERE_PAR_MANAGER`, champs grisés avec un
mot d'explication) — « Manager gagne ».

### 4.2 Garde HMAC entrante (C7) — double acceptation pendant la transition
`InternalSecretGuard` accepte **soit** `X-App-Id: manager` + `X-App-Timestamp` (± 300 s) + `X-App-Signature`
(HMAC-SHA256 de `${ts}.${JSON.stringify(corps)}` avec `VIZYO_MANAGER_APP_SECRET` — la valeur que Manager a déjà),
**soit** `X-Internal-Secret` (ancien) avec un avertissement journalisé. Sans corps, `${ts}.` et `${ts}.{}` sont tous
deux acceptés. Manager envoie **les deux preuves ensemble** pendant la transition : tant que Tracky n'a pas
`VIZYO_MANAGER_APP_SECRET`, c'est le secret statique qui juge (avertissement « poser la variable ») ; une fois posé,
c'est la signature qui juge — une fausse signature n'est plus rattrapée par le secret statique. Fin de transition :
Manager retire `VIZYO_TRACKY_INTERNAL_SECRET` de son `.env.prod`, puis Tracky retire l'acceptation du secret statique.

### 4.3 Synchronisation avec la session Manager (17/09, après lecture de `docs/LOT_D_TRACKY_INTERNAL_CLIENTS.md`)
Manager a livré le § 3 sur `feat/lot-d-manager-tracky-internal-clients` (`59f0c89`), non poussé, non déployé.
Écarts relevés entre son contrat sortant et mes routes — **tous alignés côté Tracky** (`9476a1cc` → commit suivant) :
`PUT` envoie `isActive` + `archived` (j'avais `active`) ; `DELETE` part sans corps ; `GET fleets?unlinked` doit rendre
`{ id, name, adminEmail }` ; HMAC + secret statique envoyés ensemble. Décisions Manager validées du point de vue Tracky :
idempotence de `POST /internal/clients` sur `(origin, externalRef)` (Tracky envoie `externalRef = id de la demande`) ;
409 explicite si l'e-mail est déjà client d'une autre fiche (Tracky affiche le message) ; pas d'essai TRACKY ; C11 par les
routes existantes `fleet/activate` / `suspend` ; `adminEmail` seulement par le `PATCH` d'`updateEmail()`. Remarque
Manager appliquée : un `message` en tableau (pipe de validation) est désormais joint et affiché.

### 4.3 Écran `/admin/societes` (lot E, pas D) — seulement ce que D impose : rien.

---

## 5. Variables d'environnement

| Où | Variable | Valeur | Quand |
|---|---|---|---|
| Manager (prod, `/opt/vizyo-manager/.env.prod`) | `INTERNAL_ALLOWED_APPS` | ajouter `tracky` (la ligne existe déjà) → `leads,tracky` | déploiement Manager § 3.1 |
| Manager (prod, `/opt/vizyo-manager/.env.prod`) | `VIZYO_TRACKY_APP_SECRET` | déjà présente et **identique** à `VIZYO_AUTH_APP_SECRET` de Tracky (comparées par empreinte le 17/09) — rien à distribuer | idem |
| Tracky (prod, `deploy/vps/.env.prod`) | `MANAGER_INTERNAL_URL` | **`http://vizyo-manager-api:3001`** — vérifié le 17/09 : le conteneur `vizyo-manager-api` écoute sur 3001 et partage le réseau Docker `foodsqan-public` avec `tracky-api` ; **vide = bouton inactif** (aujourd'hui) | après § 3.1 en prod |
| Tracky (prod) | `MANAGER_WEB_URL` | défaut `https://manager.vizyoagency.com` (rien à faire) | — |
| Tracky (prod) | `VIZYO_MANAGER_APP_SECRET` | pour la garde HMAC entrante (§ 4.2) | déploiement Tracky § 4 |

Tracky lit `MANAGER_INTERNAL_URL` au démarrage : après l'avoir posée, **recréer l'API par `deploy.sh`** (jamais
`docker compose up` à la main ; jamais entre 05:30 et 09:00 Paris ; le script attend la santé et revient seul en
arrière sinon — cf. `docs/fiabilite-coupe-circuit-2026-09/31-INCIDENT-DEPLOIEMENT-2026-09-17-API-A-TERRE-56-MIN.md`).

---

## 6. Ordre de déploiement (sans rien casser)

0. **Tracky § 4** (branche `feat/rdv-lot-d-tracky`) peut partir **à tout moment** : compatible avec le Manager
   d'aujourd'hui (secret statique encore accepté), routes nouvelles inutilisées tant que Manager ne les appelle pas.
   Poser `VIZYO_MANAGER_APP_SECRET` dans `deploy/vps/.env.prod` de Tracky (= `VIZYO_MANAGER_APP_SECRET` de Manager) —
   avant ou après, la garde s'adapte (§ 4.2).
1. **Manager § 3.1–3.4 + 3.6** (aucune dépendance Tracky : `fleet/provision` accepte déjà tout). Déployer Manager
   avec `INTERNAL_ALLOWED_APPS=leads,tracky`, `TRACKY_SYNC_ENABLED` absent (= false).
   Recette : depuis l'écran Tracky de prod, valider une demande d'un lien prospect créé sur « Client test » ?
   ⚠️ Non — la création passe par Manager et crée un **vrai client** (Vizyo Auth, e-mails) : recetter avec un client
   de test nommé « TEST lot D — à supprimer », puis l'effacer dans Manager **et** dans Tracky (`DELETE fleet/:id`
   n'existe pas encore : suppression Tracky par l'API admin après le § 4, ou à la main d'ici là — le noter).
2. **Tracky `.env.prod` : `MANAGER_INTERNAL_URL`**, puis `deploy.sh` (hors fenêtre du matin). Le bouton devient un clic.
3. **Tracky § 4** déjà en prod (étape 0) : poser `TRACKY_SYNC_ENABLED=true` côté Manager → la synchro sortante
   (§ 3.5) s'active sans redéploiement de code. Recette § 7 (renommer, désactiver/réactiver, archiver, effacer).
4. **Manager** : retirer `VIZYO_TRACKY_INTERNAL_SECRET` de son `.env.prod` (HMAC seul).
5. **Tracky** : retrait de l'acceptation du secret statique → `deploy.sh`.

---

## 7. Recette de bout en bout (à écrire comme script, par l'API, avec ménage)

1. Tracky : lien prospect « TEST lot D » → demande (2 véhicules, contact complet) → « Créer le client dans Vizyo Manager
   et valider » → Manager crée le client (Auth + Leads si voulu + Tracky) → Tracky rattache `trackyFleetId`, crée 2 poses.
2. Manager : la fiche client porte `origin = tracky-rdv`, `externalRef`, le contact ; Tracky : la flotte porte `clientId`,
   l'admin `firstName/lastName/phone` corrects (plus « prénom = société »).
3. Manager : renommer la société → Tracky renomme la flotte (§ 4) ; désactiver → tous les membres suspendus ; réactiver →
   tous réactivés ; archiver → invisible partout ; effacer → cascade.
4. Rejeu de la création (idempotence) : pas de deuxième flotte, pas de deuxième client.
5. Ménage : client de test effacé des deux côtés ; e-mails de test signalés au propriétaire.

---

## 8. Un compte Vizyo Auth est unique — les cas passés en revue le 17/09 (Tracky × Manager × Auth)

Règle du propriétaire : *un compte Vizyo Auth vaut pour toutes les applications ; Manager crée les comptes et donne
les accès*. Lecture de `vizyo-auth/apps/api/src/auth/auth.service.ts` (`register`) et de `clients.service.ts` (Manager,
`59f0c89`) — ce que fait la chaîne, cas par cas :

| Cas | Vizyo Auth (`register`, appli Manager) | Manager | Tracky (`fleet/provision`) |
|---|---|---|---|
| e-mail inconnu partout | crée l'identité + lien Manager ; puis lien Leads, lien Tracky | fiche créée | flotte + admin créés (`existed:false`) |
| e-mail connu d'Auth (Leads seul, ou Tracky seul), sans fiche Manager | **relie** l'identité existante à Manager (`linkedExisting`, mot de passe **ignoré**) — pas de doublon | fiche créée ; ⚠️ le « mot de passe généré » affiché n'est pas celui du compte (F1, § 9) | si l'e-mail est déjà admin d'une flotte **du même nom** → cette flotte (`existed:true`) ; sinon **409 nommant la flotte** (§ 1.2) |
| e-mail déjà relié à l'appli Manager dans Auth, sans fiche | 409 « already registered for this app » | 409 | — |
| e-mail déjà fiche Manager | — | 409 nommant la société (et sa flotte) | — |
| même demande Tracky rejouée (`origin`, `externalRef`) | — | même `{ clientId, trackyFleetId }`, répare la flotte si absente | idempotent |
| e-mail admin d'une AUTRE société dans Tracky (nom différent) | relie | fiche créée **sans flotte**, 503 avec le motif Tracky | 409 `COMPTE_DEJA_DANS_UNE_AUTRE_FLOTTE` — jamais un client rattaché à la société d'un autre ; l'opérateur « Adopte » explicitement ou change d'e-mail |
| e-mail simple membre (VIEWER…) d'une flotte Tracky | relie | idem | 409 (un membre n'administre pas une société) |
| flotte déjà reliée à un autre client Manager | — | — | 409 `FLOTTE_D_UN_AUTRE_CLIENT` |
| e-mail SUPER_ADMIN Tracky (compte sans flotte) | relie | 503 avec le motif | 409 « existe déjà sans flotte » |

Aucun chemin ne crée deux identités Auth pour un même e-mail, ni deux flottes pour un même admin, ni ne rattache un
client à la société d'un autre sans un geste explicite (« Adopter »).

### 8.1 Recette de bout en bout en production (17/09, 15:40–15:50 Paris)
Tracky `1ba0cc25` (13:37 UTC) et Manager `336b3e9` (13:42 UTC) déployés ; recette par les API depuis le conteneur
`tracky-api` (script `recette-prod-lot-d-e2e.js`, e-mail fixe `recette-lot-d@vizyoagency.com`) :
- **A** garde Manager : sans en-têtes 401, mauvaise signature 401, signature de Tracky valide + clé inconnue → 400
  de la pipe (ordre garde → pipe prouvé en prod, rien créé) ;
- **B** un clic : lien prospect → demande → `confirm { creerClient: true }` → **client créé dans Manager (Auth,
  contact « Recette LotD », `origin: tracky-rdv`, `externalRef` = id de la demande), flotte provisionnée, demande
  CONFIRMED, 1 pose** ; rejeu → 400 ; même e-mail sur une autre demande → 409 nommant la société ;
- **C** (`TRACKY_SYNC_ENABLED=true`) : renommer + contact dans Manager → flotte renommée, admin « Recette Synchro »
  marqué géré par Manager, 409 en modifiant son prénom dans Tracky ; désactiver → membres suspendus ; réactiver →
  réactivés ; archiver → liens fermés ;
- **D** effacement définitif depuis Manager → Tracky d'abord (`trackyFleetDeleted: true`), puis Manager.

Deux trous vus en prod et corrigés dans la foulée (commit suivant `1ba0cc25`) : (1) `DELETE fleet` laissait la
demande de RDV et le COMPTE admin orphelins (`fleetId` SetNull) — désormais effacés explicitement ; (2) réactiver un
client ARCHIVÉ réactivait ses comptes sur une flotte archivée — refusé (409 « désarchivez-la »), sauf par
`unarchive`. Un troisième garde-fou avant le premier « Resynchroniser » des **quatre clients de prod** (A2R, Ahmed,
cdef31, mh cars — fiches Manager **sans contact**, admins Tracky corrigés à la main) : à la **première** synchro
d'une flotte jamais synchronisée, un `null` de Manager ne vaut pas « effacer » — il vaut « je ne sais pas ».

## 9. Trouvailles de la revue croisée (à traiter côté Manager, non bloquantes)

- **F1** — `create()` affiche `generatedPassword` même quand Auth a **relié une identité existante** (`linkedExisting:
  true`, `passwordIgnored: true`) : ce mot de passe ne fonctionne pas. Afficher « compte Vizyo existant relié — mot de
  passe inchangé » à la place (le client passe par « mot de passe oublié » / « Choisir mon mot de passe », lot C).
- **F2** — `deleteClient()` retire les accès applicatifs mais l'identité Auth reste (sans appli) : inerte, mais à
  savoir pour les recettes (un e-mail de test reste « connu » d'Auth → rejouer une création avec le même e-mail relie
  l'ancienne identité).
- **F3** — l'effacement Tracky part **sans corps** : la garde côté Tracky est « depuis l'archive seulement » ; si
  Manager retape le nom de la société avant d'effacer (Q12), l'envoyer en `{ confirmName }` ajoute une vérification.

## 10. Ce qui peut mal tourner (déjà vu)

- **Signature HMAC** : le corps signé par Tracky est `JSON.stringify(body)` avec les clés dans l'ordre du § 1.1 ; Manager
  vérifie sur `JSON.stringify(req.body)` (corps reparsé par Express, même ordre). Tout middleware qui réécrit le corps
  avant la garde casse la signature. Tester la garde avec un corps réel signé par le code de Tracky
  (`manager-client.service.spec.ts` montre comment il signe).
- **`forbidNonWhitelisted`** : une clé oubliée dans le DTO = 400 « property X should not exist » — et Tracky affichera ce
  message à l'opérateur.
- **Réponse d'erreur Tracky** : `{ error: { message } }`, pas `{ message }` (§ 1.2).
- **Deux flottes pour un client** : impossible côté Tracky (idempotence par e-mail/authUserId) — mais Manager doit relire
  `existed: true` comme un succès.
- **Migration Prisma Manager** : la rejouer en entier sur une base vierge avant de pousser (leçon Tracky du 17/09 :
  `pnpm verif:migrations` ; Manager n'a pas ce garde-fou — l'ajouter serait bienvenu).
- **Fenêtres de production** : un déploiement Tracky ne se fait jamais entre 05:30 et 09:00 Paris ; Manager n'a pas cette
  contrainte, mais un Manager mort pendant qu'un opérateur valide = 503 propre côté Tracky, sans demi-client.
