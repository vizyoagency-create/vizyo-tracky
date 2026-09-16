# Conception v2 — réservations d'installation & plannings (16/09/2026, révision 2)

> **CONCEPTION COMPLÈTE — en attente du « go ».** Ce document intègre les réponses du propriétaire aux
> **treize** questions (Q1–Q8 du [plan du matin](./2026-09-16-ANALYSE-ET-PROPOSITIONS-RESERVATIONS-PLANNINGS.md),
> Q9–Q13 de la révision 1). Il décrit, écran par écran et table par table, ce qui sera construit. **Rien n'est codé.**
> Lecture faite sur Tracky `main` `c357e274` (= prod) et Vizyo Manager `283ee2e`.

---

## 0. Vos réponses, telles que je les ai comprises

| # | Réponse | Ce que ça devient |
|---|---|---|
| Q1 | Créer la société à la validation — mais la création d'une flotte est **sensible**, elle passe par **Vizyo Manager** | Manager reste le **seul créateur** de client ; Tracky déclenche et rattache (§ 2.3) ; défauts du flux corrigés (§ 1.2) |
| Q2 | Inviter directement le client comme administrateur ; bien récupérer son e-mail | E-mail **« Votre espace Tracky est prêt »** à la validation, bouton « Choisir mon mot de passe » (§ 2.4) |
| Q3 | E-mail **et** téléphone obligatoires | Obligatoires et normalisés sur la page publique (§ 5.1) |
| Q4 | Fériés fermés par défaut + un écran pour les congés, vacances… | Onglet **Disponibilités** : fermetures, fériés, jour plein (§ 5.3) |
| Q5 | Annulation jusqu'à la **veille midi**, ensuite « appelez-nous » avec **WhatsApp** | Page « Votre rendez-vous », règle J-1 12:00, boutons Appeler + WhatsApp (§ 5.2, § 7.6) |
| Q6 | Multi-véhicules, **1 véhicule = 2 h** | « Combien de véhicules ? », créneau `2 h × n`, une pose par véhicule (§ 7.4) |
| Q7 | Supprimer ce qui est « test » ; options de suppression dans l'admin | Planning « TEST » supprimé le 16/09 ; suppressions § 8 |
| Q8 | À la suppression d'un lien avec des demandes : demander « tout effacer » ou « conserver » | Dialogue à deux boutons (§ 8.1) |
| **Q9** | Le compte Manager **est** le compte Tracky : **synchroniser** — un champ modifié dans Manager (e-mail, ou tout autre) change automatiquement dans Tracky | **Synchronisation Manager → Tracky** (§ 2.5) : Manager reste la source de vérité, pousse chaque changement, et chaque poussée est journalisée et re-jouable |
| **Q10** | Garder la flotte « Client test » pour les tests | Conservée telle quelle ; c'est la flotte de recette de tous les lots (§ 10) |
| **Q11** | Oui pour le téléphone et WhatsApp ; « Envoyer un message sur WhatsApp pour avoir plus d'informations » | `INSTALLATION_PUBLIC_PHONE` + `INSTALLATION_PUBLIC_WHATSAPP` = 06 52 07 70 38 ; bouton WhatsApp avec message prérempli (§ 5.1, § 5.2) |
| **Q12** | Supprimer = **archiver** ; pouvoir **effacer** l'archive ensuite ; filtre « archivés », **masqués par défaut** | Archivage des sociétés (§ 8.4) : `archivedAt`, masquées partout, filtre, puis « Effacer définitivement » depuis l'archive |
| **Q13** | **Pas** de SMS automatique : rappel par **e-mail** seulement, plus un bouton **« Envoyer un rappel SMS »** manuel | Rappel J-1 par e-mail ; bouton SMS manuel sur chaque demande confirmée, journalisé (§ 6) |

---

## 1. Comment un compte Tracky naît aujourd'hui — et ce qui cloche

### 1.1 Le flux réel (lu dans `vizyo-manager-api/src/clients/clients.service.ts` et `apps/api/src/internal/internal.controller.ts`)

```
Vizyo Manager : « Nouveau client » (companyName, email, trackyEnabled)
  1. Vizyo Auth  ← register(email, mot de passe GÉNÉRÉ « Vz…!1 », displayName = companyName)   [app Manager]
  2. Vizyo Auth  ← registerForLeads(…)                                                        [app Leads, non bloquant]
  3. Vizyo Auth  ← registerForTracky(…)                                                       [app Tracky, non bloquant]
  4. Tracky      ← POST /api/internal/fleet/provision { fleetName, adminAuthUserId, adminEmail, adminFirstName: companyName }
                    → Fleet créée + User FLEET_ADMIN créé (authUserId posé, mot de passe = celui de l'étape 1)
  5. Manager     : Client { trackyEnabled, trackyFleetId } + User CLIENT ; essai automatique de 14 j sur… Leads
  6. Le mot de passe généré est AFFICHÉ à l'opérateur (« generatedPassword ») — c'est lui qui le transmet
```

Tracky n'a **aucune** route pour créer, modifier ou supprimer une flotte lui-même : seul Manager le fait
(`InternalSecretGuard`, en-tête `X-Internal-Secret`). Tracky sait suspendre/réactiver une flotte sur ordre de Manager,
et synchronise le statut des comptes vers Vizyo Auth (`AuthAccountSyncService`, réparé le 02/08).

### 1.2 Les défauts trouvés (corrigés dans ce chantier, côté Tracky et côté Manager)

| # | Où | Défaut | Preuve | Correction |
|---|---|---|---|---|
| C1 | Manager → Tracky | **`clientId` n'est jamais envoyé** : `provisionTrackyFleet()` accepte `clientId?` mais `create()` ne le passe pas. | `select "clientId" from fleets` en prod : **vide sur les 5 flottes** | Manager envoie `clientId` ; Tracky le stocke et l'affiche |
| C2 | Manager → Tracky | **Le prénom de l'admin reçoit le nom de la société** (`adminFirstName: dto.companyName`, pas de `lastName`). | Prod : « Administeur / A2R », « Administrateur / Anouar » — corrigés à la main | Manager gagne des champs de **contact** (prénom, nom, téléphone) et les envoie |
| C3 | Tracky `provisionFleet` | **Ni transaction ni idempotence** : flotte créée puis `user.create` peut échouer → **flotte orpheline** ; rejouer crée une deuxième flotte. | Lecture du code | `$transaction` + idempotence par `adminEmail` |
| C4 | Manager | Un client `trackyEnabled = true` **sans** `trackyFleetId` (provision échouée) est **irréparable** (« already enabled »). | Lecture du code | `activateTracky()` reprovisionne ce cas |
| C5 | Manager | **Essai automatique Leads** pour tout client, y compris un client Tracky seul. | `autoTrialApps = ['LEADS']` | Essai selon les apps activées |
| C6 | Tracky | **Aucun e-mail d'accueil** ; mot de passe transmis à la main ; lien « oublié » de **60 min**. | `forgotPassword()` | E-mail « Votre espace Tracky » + page « Choisir mon mot de passe » (§ 2.4) |
| C7 | Tracky ↔ Manager | Sécurité asymétrique : Tracky entrant = secret statique ; Manager entrant = **HMAC + horodatage**. | Lecture du code | Tracky entrant passe au **HMAC** dans ce chantier (les nouvelles routes de synchro le justifient) |
| C8 | Tracky `createFleetUser` | Reçoit un **mot de passe en clair** choisi par Manager, rôle figé `VIEWER`. | Lecture du code | Hors chantier ; noté |
| C9 | Tracky | L'**invitation** (`/accept-invite`) enregistre elle-même le compte Vizyo Auth : inutilisable sur un compte créé par Manager (409 puis 401). | `InvitationsService.accept()` | D'où § 2.4 : pas d'invitation, mais « choisir mon mot de passe » |
| **C10** | Manager | **`update()` d'un client synchronise Leads, pas Tracky** : renommer une société dans Manager ne renomme pas la flotte. | `syncClientToLeads` seul | La synchro du § 2.5 |
| **C11** | Manager | **`activateTrackyFleet()` n'est jamais appelé** : après `deactivateTracky()`, la flotte reste suspendue côté Tracky même si le client est réactivé ; et `deactivate()` d'un client ne suspend que l'admin, pas les autres comptes de la flotte. | grep : définition seule | Réactivation symétrique ; `deactivate()` suspend la flotte entière (§ 2.5) |

**Ce que ça impose :** Tracky ne crée jamais une flotte seul ; Manager est la **source de vérité** du client (nom, contact,
statut) et **pousse** chaque changement vers Tracky (§ 2.5). Tracky se contente de rattacher, refléter, et le dire.

---

## 2. Le parcours cible : du lien au client équipé

```
 Lien « prospect »            Demande               Validation                     Pose                    Accès
 (sans flotte, avec        (page publique :      (admin Tracky :             (planning → une pose      (e-mail « Votre
  nom de société)     →     société, contact  →   rattacher une flotte    →   par véhicule ; « Valider →  espace Tracky »
                            e-mail + tél,          OU créer le client            la pose » provisionne      dès la validation,
                            véhicules × 2 h)       via Manager, un clic)         véhicule + boîtier)        rappel à la pose)
```

### 2.1 Le lien « prospect »
- Formulaire admin : « Société » devient un sélecteur dont la première entrée est **« Pas encore de compte flotte
  (prospect) »**. Ce choix révèle **« Nom de la société * »**. Le reste ne change pas.
- La page publique affiche `companyName` (prospect) ou `fleet.name`.
- Le lien porte **qui l'a créé** (« créé par Youness H. le 16/09 ») et un plafond de véhicules (`maxVehicles`, 3).

### 2.2 La demande (page publique)
Contact **obligatoire** : nom, e-mail, téléphone (+ société si le lien est générique sans flotte, + adresse de pose).
Véhicules : « Combien de véhicules ? » (1 à `maxVehicles`) → créneaux de `slotMinutes × n` ; une ligne par véhicule.
Accusé de réception **immédiat** avec le récapitulatif et le lien « Votre rendez-vous » (§ 5.2).

### 2.3 La validation (admin)
L'écran « Valider » d'une demande **sans flotte** propose : **rattacher une flotte existante** (sélecteur, flottes actives)
**ou** **« Créer le client dans Vizyo Manager »** — un clic : Tracky appelle `POST /internal/clients` de Manager
(guard HMAC existant, appli `tracky` autorisée) avec `{ companyName, email, contactFirstName, contactLastName, phone,
notificationEmail: email, trackyEnabled: true, trackyFleetName: companyName, origin: 'tracky-rdv', externalRef: bookingId }`.
Manager exécute **exactement** son `create()` habituel (Auth Manager + Leads + Tracky, provision, client, essai) et répond
`{ clientId, trackyFleetId }`. Tracky rattache. Manager injoignable → la validation s'arrête proprement
(« Vizyo Manager ne répond pas ; réessayez ») — **jamais de demi-client**.

Puis, comme aujourd'hui : planning (créé s'il n'existe pas, nommé d'après la **société**), **une pose par véhicule**
(plaque « À confirmer » si inconnue), notes du client → notes terrain, adresse et créneau visibles sur la pose.
Le lien hérite de la flotte pour les demandes suivantes.

> Le bouton « Créer dans Vizyo Manager (formulaire prérempli) » reste disponible en secours si l'appel direct échoue
> deux fois : il ouvre Manager avec les champs remplis, puis « Actualiser les flottes » et rattachement.

### 2.4 L'accès du client (Q2)
Le compte admin existe dès la provision (créé par Manager, mot de passe généré inconnu du client). Tracky envoie à la
validation **« Votre espace Tracky est prêt »** (modèle `installation_access`) avec **« Choisir mon mot de passe »** →
page `app-tracky/bienvenue?e=<email>` qui, **au clic**, appelle `forgot-password` (jeton Vizyo Auth de 60 min fabriqué à
cet instant) et affiche « Un lien valable une heure vient de vous être envoyé ». L'e-mail d'accueil reste valable
indéfiniment ; le jeton court n'est jamais périmé quand on s'en sert. Repris dans l'e-mail de fin de pose (§ 6).
Aucune invitation Tracky (C9).

### 2.5 La synchronisation Manager → Tracky (Q9)

**Principe.** Un client Manager et une flotte Tracky sont **la même chose vue de deux côtés** ; le compte Vizyo Auth est
commun. Manager est la source de vérité de l'identité du client ; Tracky la reflète. La synchronisation est
**à sens unique** (Manager → Tracky), **par événement** (chaque écriture dans Manager pousse aussitôt), **journalisée**
des deux côtés, et **re-jouable** (un bouton « Resynchroniser » dans Manager rejoue l'état complet).

| Événement Manager | Appel vers Tracky (nouveau sauf mention) | Effet Tracky |
|---|---|---|
| création (`create`, `activateTracky`) | `POST /internal/fleet/provision` (existant, complété C1–C3) | flotte + admin, `clientId` posé |
| modification (`update` : `companyName`, contact, `notificationEmail`) | `PATCH /internal/fleet/:fleetId` `{ name?, contact?: { firstName, lastName, phone }, notificationEmail? }` | `fleet.name`, admin `firstName/lastName/phone`, `weeklyReportEmail` |
| changement d'**e-mail de connexion** | même `PATCH` avec `adminEmail` — **seulement si Vizyo Auth l'a accepté d'abord** (l'e-mail est l'identifiant d'Auth ; Manager change Auth, puis pousse) | `user.email` de l'admin |
| désactivation / réactivation du client (`deactivate`, `activate`) | `POST /internal/fleet/suspend` / `activate` (existants) — **la flotte entière**, symétriquement (C11) | membres `isActive`, Vizyo Auth aligné |
| **archivage** du client (nouveau dans Manager, Q12) | `POST /internal/fleet/:fleetId/archive` | § 8.4 |
| désarchivage | `POST /internal/fleet/:fleetId/unarchive` | § 8.4 |
| **effacement définitif** (depuis l'archive, Q12) | `DELETE /internal/fleet/:fleetId` | cascade totale, journalisée |
| resynchronisation manuelle | `PUT /internal/fleet/:fleetId` (état complet) | idempotent |

Règles :
- **Manager gagne** : si un opérateur corrige à la main le nom de l'admin dans Tracky, la prochaine poussée l'écrase ;
  Tracky affiche sur la flotte et sur l'admin « synchronisé depuis Vizyo Manager le … » et rend ces champs **non
  modifiables** dans Tracky quand `clientId` est posé (un lien « modifier dans Manager » à la place).
- **Jamais silencieux** : un appel qui échoue est journalisé dans Manager (`trackySyncFailedAt` + motif, visible sur la
  fiche client, bouton « Resynchroniser ») **et** dans le journal Système de Tracky quand il arrive incomplet.
- **Sécurité** : les routes `/internal/*` de Tracky passent au **HMAC + horodatage** (même schéma que Manager, C7) ;
  l'ancien secret statique est retiré une fois Manager déployé.
- Les flottes **sans `clientId`** (créées avant ce chantier, seeds, « Client test ») ne sont pas synchronisées : Tracky
  les signale « non reliée à Manager » ; un bouton Manager « Adopter une flotte Tracky existante » (sélection par nom)
  pose le `clientId` — sans jamais créer de doublon (C3).

---

## 3. Modèle de données

Toutes les migrations sont **additives** (colonnes nullables ou avec défaut, nouvelles tables) : l'image précédente
lit encore chaque table → le repli `--repli` reste possible. Les colonnes rendues obsolètes sont conservées une
version, documentées « obsolète », puis retirées au chantier suivant.

### 3.1 `installation_booking_links`
| Champ | Changement | Pourquoi |
|---|---|---|
| `fleetId` | devient **nullable** (relation `Fleet?`, cascade conservée) | lien prospect |
| `companyName String?` | nouveau | nom affiché sans flotte ; obligatoire si `fleetId` nul (règle service) |
| `createdBy` | gagne une **relation** `creator User?` (`onDelete: SetNull`) | « créé par … » |
| `maxVehicles Int @default(3)` | nouveau | plafond du multi-véhicules |
| `slotMinutes` | inchangé (120) = durée **par véhicule** | Q6 |

### 3.2 `installation_bookings`
| Champ | Changement | Pourquoi |
|---|---|---|
| `linkId` | **nullable**, `onDelete: SetNull` (était Cascade) | Q8 « conserver » |
| `linkLabel String?` | nouveau, recopié à la création | lisible après suppression du lien |
| `fleetId` | **nullable** | demande d'un prospect |
| `companyName String?` | nouveau | |
| `vehicleCount Int @default(1)` | nouveau | `endAt = startAt + slotMinutes × vehicleCount` |
| `clientPhone` | reste `String?` en base, **obligatoire par le service** (E.164) | Q3 |
| `manageTokenHash String? @unique` | nouveau | page « Votre rendez-vous » |
| `cancelledAt`, `cancelledBy` (`'client'` ou id), `cancelReason` | nouveaux | annulation |
| `confirmedBy` | relation `confirmer User?` | « validée par … » |
| `reminderEmailSentAt`, `reminderSmsSentAt`, `reminderSmsSentBy` | nouveaux | rappel e-mail auto (une fois) ; SMS manuel (Q13) |
| `taskId`, `vehiclePlate/Brand/Model/Energy` | **obsolètes** — conservés, plus écrits | multi-véhicules (§ 3.3) |

### 3.3 `installation_booking_vehicles` (nouvelle)
`id`, `bookingId` (cascade), `position Int`, `plate String?`, `brand String?`, `model String?`, `energy InstallationEnergy?`,
`taskId String? @unique` (la pose créée à la validation, `SetNull`).

### 3.4 `installation_tasks`
| Champ | Changement | Pourquoi |
|---|---|---|
| `bookingId String?` (+ index), `onDelete: SetNull` | nouveau | plusieurs poses par demande ; l'éditeur affiche créneau, téléphone, adresse, notes |
| `plate` | reste obligatoire ; la validation écrit **« À confirmer »** si inconnue, `completeTask` exige une vraie plaque | R9 |

### 3.5 `installation_closures` (nouvelle) — Q4
`id`, `startDate @db.Date`, `endDate @db.Date`, `label String`, `createdBy` (relation `User?`), `createdAt`. Jours entiers.

### 3.6 `installation_settings` (nouvelle, une ligne)
`maxManualTasksPerDay Int @default(3)` (jour plein), `holidaysEnabled Boolean @default(true)`, `cancelDeadlineHour Int @default(12)`,
`updatedBy`, `updatedAt`. Téléphone et WhatsApp de l'atelier en variables d'environnement (`INSTALLATION_PUBLIC_PHONE`,
`INSTALLATION_PUBLIC_WHATSAPP`, à poser en prod = 06 52 07 70 38 / 33652077038 — Q11).

### 3.7 `fleets` — synchro et archivage
| Champ | Changement | Pourquoi |
|---|---|---|
| `clientId` | existant, **renseigné** par Manager (C1) | relier |
| `managedByManagerAt DateTime?` | nouveau : date de la dernière synchro reçue | « synchronisé le … », champs verrouillés |
| `archivedAt DateTime?`, `archivedBy String?` (+ index) | nouveaux | Q12 |
| `contactPhone String?` | nouveau | contact du client (le téléphone de l'admin vit sur `users.phone`, déjà là) |

### 3.8 `users`
`managedByManager Boolean @default(false)` sur l'admin créé par provision : ses champs d'identité sont pilotés par Manager.

---

## 4. API

### 4.1 Public (`/api/public/booking`, hors auth, débit borné)
| Route | Changement |
|---|---|
| `GET :token` | + `companyName`, `maxVehicles`, `contact: { phoneRequired: true }`, `atelier: { phone, whatsappUrl }`, `annulation: { heureLimite }` |
| `POST :token` | + `vehicleCount`, `vehicles[]`, `companyName?`, **`clientPhone` obligatoire** ; renvoie `manageUrl` |
| `GET :token/demande/:manageToken` | nouveau — « Votre rendez-vous » : créneau, statut, `peutAnnuler`, `peutDeplacer`, contacts atelier |
| `POST :token/demande/:manageToken/annuler` | nouveau — jusqu'à J-1 `cancelDeadlineHour` ; après → 409 `{ appelezNous: true }` |
| `POST :token/demande/:manageToken/deplacer` | nouveau — nouveau `startAt`, même règle ; une demande confirmée repasse **PENDING** |

### 4.2 Admin (`/api/installation-bookings`, SUPER_ADMIN)
| Route | Changement |
|---|---|
| `POST links` | `fleetId` optionnel, `companyName`, `maxVehicles` |
| `DELETE links/:id?demandes=conserver\|effacer` | Q8 ; sans paramètre et s'il y a des demandes → **409** avec le décompte |
| `POST :id/confirm` | + `fleetId` **ou** `creerClient: true` (Manager, § 2.3) ; crée `n` poses ; refuse sans flotte |
| `POST :id/cancel` | nouveau — `CANCELLED`, poses non faites supprimées, e-mail optionnel |
| `POST :id/reschedule` | nouveau |
| `POST :id/rappel-sms` | nouveau (Q13) — envoi manuel d'un SMS de rappel, journalisé |
| `GET/POST/DELETE closures` · `GET/PATCH settings` · `GET holidays?year=` | nouveaux (Q4) |

### 4.3 Plannings (`/api/installations`)
- `PATCH :id/reorder` (FLEET_ADMIN) : **refuse** une tâche portant `bookingId`.
- `DELETE :id/tasks/:taskId` : tâche liée → la demande est **annulée** dans le même mouvement.
- `POST :id/tasks/:taskId/complete` : dernière pose d'une demande → e-mail de fin de pose.
- DTO tâche : `booking: { startAt, endAt, clientPhone, clientAddress, notes } | null`.

### 4.4 Interne (`/api/internal`, guard **HMAC**)
| Route | Changement |
|---|---|
| `POST fleet/provision` | `clientId`, `adminFirstName`, `adminLastName`, `adminPhone` ; **transaction** ; idempotent par `adminEmail` |
| `PATCH fleet/:fleetId` | nouveau — `name`, `contact`, `adminEmail` (après Auth), `notificationEmail` |
| `PUT fleet/:fleetId` | nouveau — état complet (resynchronisation) |
| `POST fleet/:fleetId/archive` · `unarchive` | nouveaux (Q12) |
| `DELETE fleet/:fleetId` | nouveau — effacement définitif (cascade), journal Système `INTERNAL` |
| `GET fleets?unlinked=true` | nouveau — flottes sans `clientId`, pour « Adopter » |

### 4.5 Admin Tracky — sociétés (`/api/admin/fleets`, SUPER_ADMIN, nouveau)
`GET ?archived=false|true|all` · `POST :id/archive` / `unarchive` / `DELETE :id` **seulement** pour les flottes sans
`clientId` (les autres renvoient 409 « gérée par Vizyo Manager »).

### 4.6 Manager (`vizyo-manager-api`)
- `POST /internal/clients` (guard `InternalHmacGuard`, appli `tracky` ; `INTERNAL_ALLOWED_APPS += tracky`,
  `VIZYO_TRACKY_APP_SECRET`) → `clients.create()`.
- Modèle `Client` : `contactFirstName`, `contactLastName`, `phone`, `trackySyncFailedAt`, `trackySyncError`, `archivedAt`.
- `create()` / `activateTracky()` : `clientId` + contact envoyés (C1, C2), cas sans flotte reprovisionné (C4), essai
  selon apps (C5).
- `update()` : pousse vers Tracky (C10) ; `deactivate()` / `activate()` : flotte entière (C11) ; nouveaux `archive()`,
  `unarchive()`, `destroy()` ; bouton « Resynchroniser » ; « Adopter une flotte Tracky ».
- Le client HTTP Manager → Tracky signe en HMAC (C7).

---

## 5. Écrans

### 5.1 Page publique `/book/:token`
- En-tête : société, pastille « week-end possible », « créneaux de 2 h par véhicule ».
- **Étape 0 — Combien de véhicules ?** boutons 1 … `maxVehicles` ; change la durée et la grille.
- Étapes 1–2 inchangées.
- **Étape 3 — Vos informations** : Nom *, E-mail *, Téléphone * (« nous vous appelons la veille si besoin »), Société * si
  lien prospect générique, Adresse de pose *, une ligne par véhicule, remarque. Téléphone → E.164 (`toE164`).
- Après envoi : « Demande envoyée — un e-mail de confirmation vient de partir, avec le lien pour modifier ou annuler ».
- Sorties, partout où la page se ferme : **Appeler l'atelier**, **« Envoyer un message sur WhatsApp pour avoir plus
  d'informations »** (`https://wa.me/33652077038?text=` message prérempli : société, créneau, question), Prévenez-moi,
  autre créneau ; « Découvrir Tracky ».

### 5.2 Page « Votre rendez-vous » `/book/:token/demande/:manageToken`
- Récapitulatif (créneau, véhicules, adresse, statut : en attente / confirmé / annulé / posé).
- **Avant J-1 12:00** : « Déplacer » et « Annuler » (confirmation en deux temps, motif facultatif).
- **Après** : « Il est trop tard pour modifier en ligne » + **Appeler** + **WhatsApp** (message prérempli).
- Toujours : « Choisir mon mot de passe » si l'accès existe, « Découvrir Tracky ».

### 5.3 Admin `/admin/installation-bookings`
- **Demandes** : société, `n` véhicules, téléphone cliquable, « validée par … », « posée x/n » ; Valider (avec
  rattachement / création Manager), Refuser (e-mail réparé), **Annuler**, **Déplacer**, **Envoyer un rappel SMS** (Q13 :
  visible sur une demande confirmée avec téléphone, confirmation « 1 SMS vers 06 … », journalisé, date du dernier envoi).
- **Liens** : prospect ou flotte, « créé par … le … », `maxVehicles`, **Supprimer** → dialogue Q8 chiffré.
- **Agenda** : demandes (créneaux) + poses manuelles (jour) — la journée de l'installateur.
- **Disponibilités** (Q4) : fermetures (du … au … + motif), fériés à venir (exclus), seuil « jour plein », heure limite de
  la veille, numéros d'atelier (lecture).

### 5.4 Admin `/admin/societes` (nouveau, Q12)
Liste des flottes : nom, client Manager (lien), admin, véhicules, dernière synchro, état (active / suspendue /
**archivée**). **Filtre « Afficher les archivées », désactivé par défaut.** Actions : Archiver / Désarchiver / Effacer
définitivement — actives uniquement pour les flottes **non reliées à Manager** ; pour les autres, « gérée par Vizyo
Manager → ouvrir dans Manager ». « Effacer définitivement » exige de **retaper le nom** de la société et affiche le
décompte (véhicules, positions, trajets, comptes, plannings, liens).

### 5.5 Plannings
Une pose réservée en ligne affiche « Réservé : jeu. 17 sept. 10:00 – 12:00 · 06 … · adresse · note » et un cadenas
côté client. Planning auto-créé : nom de la **société**, description « Prises de RDV en ligne — créé automatiquement ».

### 5.6 Partout ailleurs (Q12)
Les flottes archivées **disparaissent** des sélecteurs (« Toutes les sociétés »), des listes de plannings, de liens, de
comptes, des rapports hebdomadaires et des automatisations ; un filtre « archivées » n'existe que sur `/admin/societes`.

---

## 6. Courriels, SMS et notifications

| Modèle (nouveau sauf mention) | À qui | Quand | Contenu clé |
|---|---|---|---|
| `installation_slot_received` | client | demande | récap, « nous confirmons sous 24 h », lien « Votre rendez-vous » |
| `installation_slot_requested` (existant) | opérateur | demande | + société, téléphone, `n` véhicules, prospect ou flotte |
| `installation_slot_confirmed` (existant, enrichi) | client | validation | + `.ics`, « Votre rendez-vous », règle J-1 12:00, Appeler / WhatsApp |
| `installation_access` | client (prospect) | validation | « Votre espace Tracky est prêt » + **Choisir mon mot de passe** |
| `installation_slot_rejected` (remplace R1) | client | refus | motif, « Choisir un autre créneau », Appeler / WhatsApp |
| `installation_slot_cancelled` | client ou opérateur | annulation | qui, quand, comment reprendre |
| `installation_reminder` | client | **J-1 vers 10:00**, **e-mail seulement** (Q13) | créneau, adresse, « pour modifier : avant midi », WhatsApp |
| **SMS de rappel** — **manuel** | client | bouton « Envoyer un rappel SMS » | via la passerelle SMS (numéro ajouté à l'allowlist du relais pour l'envoi, comme une remise en route) ; 1 SMS, journalisé, jamais automatique |
| `installation_done` | client | dernière pose faite | « Vos véhicules sont équipés » + accès + Découvrir Tracky |
| Push super-admins | opérateur | nouvelle demande, annulation client | socle notifications |

Cinq points de câblage par modèle. Adresse opérateur configurable (`INSTALLATION_NOTIFY_EMAIL`).

---

## 7. Règles métier (côté serveur, testées)

1. **Jamais le jour même** — J+`leadDays` (≥ 1), en prod depuis le 15/09.
2. **Jours fermés** — fériés français (`date-holidays` `FR`) si `holidaysEnabled` ; fermetures ; **jour plein** dès
   `maxManualTasksPerDay` tâches manuelles `PENDING` ce jour.
3. **Occupation** — demandes `PENDING`/`CONFIRMED` (EXCLUDE existant, une équipe).
4. **Multi-véhicules** — `slotMinutes × n`, départ proposé seulement si `n` créneaux consécutifs libres tiennent dans la
   fenêtre du jour (samedi 09–13 = 2 véhicules) ; `n ≤ maxVehicles`.
5. **Contact** — e-mail et téléphone obligatoires ; téléphone en E.164.
6. **Annulation / déplacement client** — jusqu'à **J-1 `cancelDeadlineHour`** (12:00 Europe/Paris) ; après : refus +
   Appeler / WhatsApp. Une demande confirmée déplacée repasse `PENDING`, poses retirées.
7. **Annulation opérateur** — à tout moment ; poses non faites retirées ; pose faite → refus.
8. **Usage unique** — se ferme à la **demande**, rouvre si refusée ou annulée.
9. **Suppression d'une pose liée** → demande annulée ; **d'un planning** → idem pour chacune.
10. **Sans flotte, pas de validation** — rattacher ou créer ; jamais de planning sans flotte.
11. **Archivée = invisible** — une flotte archivée est exclue de tout sauf de `/admin/societes` avec le filtre.
12. **Manager gagne** — champs synchronisés verrouillés dans Tracky.

---

## 8. Suppressions et archivage (Q7, Q8, Q12)

### 8.1 Un lien
Dialogue chiffré : *« Ce lien porte 3 demandes (1 en attente, 2 confirmées), 4 visites, 1 abonné. »*
- **Conserver les demandes** : elles restent (statut inchangé, `linkLabel` gardé) ; visites et abonnés effacés.
- **Tout effacer** : demandes (et véhicules), visites, abonnés ; les poses déjà créées survivent, sauf case « retirer aussi
  les poses non faites ».

### 8.2 Un planning
Existant (dialogue chiffré). Ajout : demandes liées **annulées**, clients prévenus si la case est cochée.

### 8.3 Une demande
Pas de suppression : elle s'**annule**. Purge des annulées / refusées de plus de 12 mois par l'entretien quotidien.

### 8.4 Une société (Q12)
- **Supprimer = archiver** : `archivedAt` posé, membres suspendus (Vizyo Auth aligné), liens fermés, plannings masqués,
  rapports et automatisations arrêtés, flotte **invisible partout** sauf dans `/admin/societes` avec le filtre.
- **Désarchiver** : l'inverse, membres réactivés.
- **Effacer définitivement** (depuis l'archive uniquement) : cascade totale — véhicules, boîtiers dissociés (pas détruits :
  un boîtier est un objet physique réaffectable), positions, trajets, comptes (retirés de l'app Tracky dans Vizyo Auth),
  plannings, liens, demandes. Confirmation par saisie du nom, journal Système, irréversible.
- Pour une flotte **reliée à Manager**, ces trois gestes se font **dans Manager** (qui appelle Tracky, § 2.5) ; Tracky
  n'offre que le bouton « ouvrir dans Manager ». Pour une flotte non reliée (avant ce chantier, tests), Tracky les offre
  directement.

---

## 9. Nettoyage au passage

- `rejectBooking` : mail illisible et mauvais identifiant → `installation_slot_rejected`.
- Dialogue « conservées » du lien → dialogue § 8.1.
- `CONTACT_EMAIL` en dur → `INSTALLATION_NOTIFY_EMAIL`.
- `InstallationBooking.taskId` / `vehicle*`, `leadHours` : obsolètes, retirés au chantier suivant.
- Libellé « Usage unique » rendu vrai.
- `provisionFleet` : transaction, idempotence, contact, `clientId` (C1–C3) ; `/internal/*` en HMAC (C7).
- Manager : `syncClientToLeads` rejoint par `syncClientToTracky` (C10) ; `activateTrackyFleet` enfin appelé (C11).

---

## 10. Lots, ordre, effort, vérification

| Lot | Contenu | Effort | Dépôt |
|---|---|---|---|
| **A — le socle** | modèle 3.1–3.4 ; lien prospect + créateur ; contact obligatoire ; multi-véhicules ; validation avec rattachement (création Manager câblée sur le point d'entrée du lot D, bouton prérempli en secours) ; annulation opérateur ; refus réparé ; suppression Q8 ; `provisionFleet` C1–C3 | 2 j | Tracky |
| **B — le calendrier** | fermetures, fériés, jour plein, onglet Disponibilités ; poses liées (encart, verrou, annulation en cascade) ; agenda fusionné | 1,5 j | Tracky |
| **C — le client** | « Votre rendez-vous » (annuler / déplacer, WhatsApp) ; accusé, `.ics`, rappel J-1 e-mail, SMS manuel, fin de pose, accès (§ 2.4) ; push opérateur ; variables d'atelier en prod | 1,5 j | Tracky |
| **D — Manager & synchro** | `POST /internal/clients` ; contact ; C1, C2, C4, C5, C10, C11 ; `syncClientToTracky` ; archive / désarchive / effacer ; « Resynchroniser », « Adopter » ; HMAC des deux côtés | 1,5 j | Manager + Tracky (`/internal`) |
| **E — sociétés & archivage** | `archivedAt`, `/admin/societes` avec filtre, exclusion des archivées partout (sélecteurs, rapports, automatisations), effacement définitif | 1 j | Tracky |

Ordre : **A → D → B → C → E** (D tôt, parce que la validation « un clic » en dépend et que Manager se déploie à part).
Chaque lot : branche, tests, recette sur la base de dev **et sur la flotte « Client test » en prod** (Q10), `pnpm verify`,
`deploy.sh --attendre` hors fenêtre de preuve du chantier coupe-circuit. Après chaque déploiement : migration appliquée,
artefact vérifié dans le conteneur, un lien de test créé sur « Client test » puis supprimé.

**Risques nommés** : (1) le lot D touche Manager et Vizyo Auth — recette contre un Auth de test avant la prod ;
(2) `linkId` / `fleetId` nullables élargissent les `where` — chaque requête filtrant par `fleetId` est relue ;
(3) l'archivage traverse toute l'application (sélecteurs, crons, rapports) — un inventaire des lectures de `fleets`
précède le lot E ; (4) le SMS manuel passe par le relais Android (S21) et son allowlist — un SMS = un coût, jamais automatique.

---

## 11. Tranché

Toutes les questions ont une réponse (§ 0). Il ne reste qu'un mot : **« go lot A »** — ou vos corrections sur ce document.
