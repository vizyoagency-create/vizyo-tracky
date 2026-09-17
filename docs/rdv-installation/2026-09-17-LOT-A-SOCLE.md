# Lot A — le socle (17/09/2026)

> Premier lot de la [conception v2](./2026-09-16-CONCEPTION-V2-RESERVATIONS-PLANNINGS.md) (§ 10),
> lancé sur « go lot A ». Branche `feat/rdv-lot-a` depuis `main` `f05fa4b8`.
> Ce document dit **ce qui est construit**, **ce qui change pour l'opérateur et pour le client**,
> **comment ça a été vérifié**, et **ce qui attend les lots suivants**.

---

## 1. En une page

| Avant (prod du 16/09) | Après le lot A |
|---|---|
| Un lien exige une flotte : impossible d'envoyer un lien à un client qui n'a pas encore de compte. | Le lien vise **une flotte OU un prospect nommé** (« Pas encore de compte flotte » + nom de la société). La flotte est rattachée à la validation — ou créée par Vizyo Manager. |
| On ne sait pas qui a créé un lien. | Chaque lien porte **« créé par … le … »** (`createdBy` relié à `users`). |
| Sur un lien nominatif, la page ne demandait rien ; sinon nom + e-mail, téléphone facultatif. | **Nom, e-mail et téléphone toujours demandés** (pré-remplis sur un lien nominatif). Téléphone stocké en E.164, e-mail en minuscules. |
| Un véhicule par demande, une pose à la validation, plaque exigée par l'opérateur. | **1 à 6 véhicules** par demande (plafond réglable par lien, 3 par défaut) ; la grille propose des créneaux de **2 h × n** ; **une pose par véhicule**, plaque « À confirmer » si le client ne l'a pas donnée — exigée au moment de valider la pose. |
| Le refus envoyait un corps illisible (palette sombre sur fond blanc) sous l'identifiant « confirmé ». | Modèle **`installation_slot_rejected`** propre, avec le lien s'il est encore ouvert et le téléphone de l'atelier. |
| Une demande confirmée bloquait son créneau pour toujours. | **Annulation par l'opérateur** (en attente ou confirmée) : poses non faites retirées, créneau libéré, e-mail **`installation_slot_cancelled`** optionnel, « annulée par … le … — motif ». |
| Supprimer un lien EFFAÇAIT ses demandes (cascade) alors que l'écran promettait l'inverse. | **Q8** : s'il porte des demandes, le dialogue demande **« Conserver les demandes »** (elles survivent, sous le libellé du lien) ou **« Tout effacer »**. |
| `provisionFleet` (Manager → Tracky) : flotte créée PUIS admin, hors transaction, rejouable, sans `clientId`. | **C1–C3** : transaction, idempotence (un admin connu rend SA flotte), `clientId` et téléphone stockés, prénom/nom du contact. |

---

## 2. Le modèle (migration `20260917090000_rdv_lot_a_prospect_vehicules_annulation`)

Tout est **additif** (colonnes nullables ou à défaut, une table) : l'image précédente lit encore chaque table.

| Table | Changement |
|---|---|
| `installation_booking_links` | `fleetId` **nullable** ; `companyName` ; `maxVehicles` (défaut 3) ; FK `createdBy → users` (SET NULL). |
| `installation_bookings` | `linkId` **nullable, SET NULL** (au lieu de CASCADE) ; `linkLabel` (recopié à la création) ; `fleetId` nullable **et enfin relié** (`fleets`, SET NULL) ; `companyName` ; `vehicleCount` ; `cancelledAt` / `cancelledBy` / `cancelReason` ; FK `confirmedBy → users`. `taskId` et `vehicle*` **obsolètes** (conservés pour le repli d'image, plus écrits). |
| `installation_booking_vehicles` (**nouvelle**) | un véhicule d'une demande : `position`, `plate`, `brand`, `model`, `energy`, `taskId` (unique, SET NULL). |
| `installation_tasks` | `bookingId` (SET NULL) + index : plusieurs poses par demande. |
| `installation_booking_link_visits` | `fleetId` nullable (visite d'un lien prospect). |

Le nouveau modèle `InstallationBookingVehicle` est **exclu** de l'import de démonstration (`demo/import/allowlist.ts`).

---

## 3. L'API

| Point d'entrée | Changement |
|---|---|
| `POST /api/installation-bookings/links` | `fleetId` facultatif ; `companyName` obligatoire sans flotte ; `maxVehicles` 1..6 ; un planning ne se rattache qu'avec une flotte. |
| `PATCH …/links/:id` | peut **rattacher** une flotte à un lien prospect (ses demandes sans flotte la reçoivent) ; ne **change jamais** la flotte d'un lien qui en a une. |
| `GET …/links/:id/consequences-suppression` | le décompte (demandes par statut, visites, abonnés) que le dialogue affiche. |
| `DELETE …/links/:id?demandes=conserver\|effacer` | sans mode alors qu'il y a des demandes → **409** avec `consequences`. |
| `GET /api/public/booking/:token?vehicules=n` | la grille pour n véhicules (créneaux de n × `slotMinutes`), n borné par `maxVehicles`. `needsClientInfo` toujours vrai, `prefill` sur un lien nominatif, `contactRequis: { email, telephone }`. |
| `POST /api/public/booking/:token` | `vehicleCount` + `vehicles[]` (concordance exigée), `clientName` / `clientEmail` / `clientPhone` **obligatoires** (E.164, e-mail valide, nom ≠ e-mail). Le créneau doit être offert **pour ce nombre de véhicules**. |
| `POST …/:id/confirm` | `fleetId` (rattacher) ou `creerClient: true` (Manager, lot D) pour une demande sans flotte — sinon **409 `sansFlotte`** avec `creationManagerConfiguree` et `urlManager` (formulaire Manager prérempli). `vehicles[{position,…}]` corrige les véhicules. Une pose par véhicule, planning nommé d'après la **société**, lien prospect rattaché, lien à usage unique refermé. |
| `POST …/:id/reject` | modèle `installation_slot_rejected` (plus « confirmé »), lien de réservation s'il est ouvert. |
| `POST …/:id/cancel` (**nouveau**) | `reason?`, `notifyClient?` ; refuse une demande refusée ou dont une pose est **faite** ; retire les poses ; `cancelledBy` = nom lisible de l'opérateur. |
| `POST /api/internal/fleet/provision` | C1–C3 (voir § 1) ; réponse `{ fleetId, existed }` ; `adminPhone` accepté. |
| `POST /api/installations/:planId/tasks/:id/complete` | refuse de **valider** (DONE) une pose dont la plaque est « À confirmer » ; la sauter reste possible. |

Nouveau service **`ManagerClientService`** (`installation-booking/manager-client.service.ts`) : `POST {MANAGER_INTERNAL_URL}/internal/clients` signé HMAC comme le garde de Manager (`X-App-Id: tracky`, `X-App-Timestamp`, `X-App-Signature` = HMAC-SHA256(`VIZYO_AUTH_APP_SECRET`, `${ts}.${corps}`)). **Inactif tant que `MANAGER_INTERNAL_URL` est vide** (prod : vide jusqu'au lot D) — l'écran propose alors le formulaire Manager prérempli.

Variables ajoutées (`env.validation.ts`, `.env.example`) : `MANAGER_INTERNAL_URL` (vide = inactif), `MANAGER_WEB_URL` (défaut `https://manager.vizyoagency.com`), `INSTALLATION_NOTIFY_EMAIL` (défaut : `contact@vizyoagency.com`). **Rien à ajouter sur le VPS pour ce lot.**

---

## 4. Les écrans

**Page publique `/book/:token`** — « Combien de véhicules à équiper ? » (1..`maxVehicles`, affiché seulement si le plafond > 1 ; la grille se recharge sur la même visite, geste `vehicules` dans la chronologie) → jour → créneau → coordonnées (nom, e-mail, téléphone **obligatoires**, adresse) → un bloc par véhicule (plaque, marque/modèle, énergie — tout facultatif) → remarque.

**Admin `/admin/installation-bookings`** —
- *Liens* : sélecteur « Société / flotte » avec **« Pas encore de compte flotte (prospect) »** + nom de la société ; « Véhicules par demande (au plus) » avec la durée du rendez-vous ; carte : badge **prospect**, « jusqu'à n véhicules », **« créé par … le … »** ; en modification, un lien prospect peut recevoir sa flotte ; suppression → dialogue **Conserver / Tout effacer / Annuler** quand il y a des demandes.
- *Demandes* : société (badge prospect), n véhicules, téléphone cliquable, la liste des véhicules, « validée par … le … · n poses », « annulée par … le … — motif », lien vers le planning ; filtre **Annulées** ; validation : pour un prospect, **rattacher une flotte** ou **« Créer le client dans Vizyo Manager et valider »** (un clic si configuré, sinon le formulaire Manager prérempli s'ouvre) + une ligne de plaque par véhicule ; **Annuler** (demande ou rendez-vous) avec motif et « prévenir le client ».
- *Agenda* : société · client · n véhicules.

---

## 5. Vérification

| Quoi | Résultat |
|---|---|
| `npx tsc --noEmit` (API) | ✅ |
| `installation-booking.service.spec.ts` (réécrit : 5ᵉ argument `ManagerClientService`, +26 cas lot A), `slots.spec`, `contact.spec`, `manager-client.service.spec.ts` (nouveau), `email-templates-catalog`, `courriels-reponse-et-logo`, `internal.controller.spec` (provision C1–C3), `installations.service.spec.ts` (nouveau), `allowlist.spec`, `catalogue-exhaustif` | ✅ voir § 5.1 |
| `ng build` (web) | ✅ |
| Migration sur la base de dev + `prisma migrate diff` | ✅ conforme (seul le bruit habituel `DROP DEFAULT` des `gen_random_uuid()`) |
| Recette navigateur (dev) | § 5.2 |
| Prod | § 6 |

### 5.1 Tests

| Suite | Résultat |
|---|---|
| API — suite complète (`jest`, 2 workers, serveurs de dev arrêtés) | **266 suites, 4 215 tests, tout vert** |
| `installation-booking.service.spec.ts` | 59 tests (30 nouveaux « lot A » : lien prospect, contact, véhicules, validation, refus/annulation, suppression Q8) |
| `manager-client.service.spec.ts` (nouveau) | 5 tests : non configuré → 503 + formulaire prérempli ; signature HMAC recalculée sur `${ts}.${corps}` ; refus 4xx ; client sans flotte → 503 ; injoignable → 503 |
| `internal.controller.spec.ts` | provision C1–C3 : transaction, idempotence, 409 sans flotte, `clientId` + téléphone |
| `installations.service.spec.ts` (nouveau) | plaque « À confirmer » : DONE refusé, SKIPPED permis |
| `pnpm typecheck` (api, web, shared), `pnpm smoke` (DI) | ✅ |
| `packages/shared` | 19 suites, 423 tests ✅ |
| `verif:litteraux`, `verif:contraste`, `verif:accents`, `verif:confirmations`, `verif:couleurs-kit`, `verif:variables`, `verif:carte-gardes` | ✅ (l'identifiant `vehicules` de la page publique, attrapé par le motif « gabarit » de `verif:accents` après une flèche `=>`, a été renommé `vehicleRows`) |

### 5.2 Recette sur la base de dev

Scénario joué **par l'API** (script `recette-lot-a.js`, 22 contrôles) **puis dans le navigateur** (page publique en
375 px, écran admin) :

1. lien sans flotte ni société → 400 ; lien prospect « Garage Martin » créé (`fleetId` null, « créé par Admin Vizyo », plafond 2) ;
2. page publique : « Combien de véhicules ? » → 2 → grille rechargée en créneaux de 4 h (`08:00 – 12:00`, …), même visite ;
3. réservation sans téléphone valide → 400 avec l'exemple `06 12 34 56 78` ; réservation valide : `+33612345678`, e-mail en minuscules, 2 lignes véhicule (plaque en majuscules, 2ᵉ sans plaque) ;
4. écran admin : société + badge **prospect**, « 2 véhicules », téléphone `tel:`, les deux véhicules, remarque ;
5. valider sans rien → 409 `SANS_FLOTTE` (URL Manager préremplie) ; « Créer dans Manager » → 503 « non configuré » (un seul toast, avec le vrai message) ; rattacher « Trackyy » + corriger la plaque du 2ᵉ → **2 poses** dans un planning « Garage Martin (UI) » (statut Publié, description automatique), pose 2 « À confirmer », lien prospect rattaché, « Validée par Admin Vizyo le … · 2 poses », lien vers le planning ;
6. annuler le rendez-vous (motif, « prévenir » décoché) → poses retirées, planning vide, « Annulée par Admin Vizyo le … — motif », filtre **Annulées** ;
7. deuxième demande (1 véhicule, sans plaque) → `consequences-suppression` = 2 demandes ; `DELETE` sans mode → 409 `DEMANDES_A_TRANCHER` ; dialogue **Conserver / Tout effacer / Annuler** ; « Conserver » → 204, les demandes survivent sous le libellé « Recette UI — prospect Martin » avec `linkId` null.

Deux défauts trouvés et corrigés pendant la recette : (a) le filtre global de l'API ne rend les champs métier
d'une exception (`consequences`, `urlManager`) **qu'avec un `code`** explicite — ajouté ; (b) l'écran lisait
`err.error.message` alors que la réponse est `{ error: { message } }` : **tous** les toasts d'erreur de l'écran RDV
(et les messages de la page publique) affichaient « Une erreur est survenue » — remplacé par `apiErrorMessage()`.

---

## 6. Déploiement

_(rempli à la fin du lot)_

---

## 7. Ce qui attend les lots suivants

- **D** : `POST /internal/clients` côté Manager (la création « un clic » de l'écran de validation est câblée et inactive : `MANAGER_INTERNAL_URL` vide), C4/C5/C10/C11, synchro Manager → Tracky, HMAC des deux côtés. Manager n'envoie pas encore `clientId` ni `adminPhone` : Tracky les accepte déjà.
- **B** : fermetures, fériés, jour plein, onglet Disponibilités ; verrou des poses liées à une demande (aujourd'hui une pose issue d'une demande se modifie comme une autre ; l'annulation de la demande la retire).
- **C** : « Votre rendez-vous » (annulation client J-1 midi, WhatsApp), accusé, `.ics`, rappel J-1, SMS manuel, accès au compte (« Choisir mon mot de passe »).
- **E** : archivage des sociétés, `/admin/societes`.
- Reste connu : `cancelledBy` est un libellé (lisible sans jointure) — le lot C y écrira « client ».
