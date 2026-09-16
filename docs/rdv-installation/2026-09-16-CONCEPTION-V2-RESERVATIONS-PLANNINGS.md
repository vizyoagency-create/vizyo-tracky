# Conception v2 — réservations d'installation & plannings (16/09/2026)

> **CONCEPTION — à valider avant la première ligne de code.** Ce document intègre les réponses du
> propriétaire aux huit questions du [plan du 16/09](./2026-09-16-ANALYSE-ET-PROPOSITIONS-RESERVATIONS-PLANNINGS.md)
> et décrit, écran par écran et table par table, ce qui sera construit. Il reste **cinq points à trancher** (§ 11).
> Lecture faite sur Tracky `main` `4c16f5e5` (= prod) et Vizyo Manager `283ee2e`.

---

## 0. Vos réponses, telles que je les ai comprises

| # | Réponse | Ce que ça devient |
|---|---|---|
| Q1 | Oui, créer la société à la validation — mais la création d'une flotte est **sensible**, elle passe d'habitude par **Vizyo Manager** | § 1 décrit le flux réel Manager → Tracky et ses défauts ; § 2 propose de **garder Manager comme seul créateur de client**, Tracky ne créant jamais une flotte « dans son coin » |
| Q2 | Inviter directement le client comme administrateur ; bien récupérer son e-mail | Un e-mail **« Votre espace Tracky »** part à la validation, avec un bouton « Choisir mon mot de passe » (§ 2.4) ; l'e-mail est obligatoire et vérifié par l'accusé de réception (§ 6) |
| Q3 | Oui : e-mail **et** téléphone | Les deux deviennent obligatoires sur la page publique, normalisés (E.164 pour le téléphone, minuscules pour l'e-mail) — § 5.1 |
| Q4 | Fériés fermés par défaut ; un écran admin pour les congés, vacances, etc. | Onglet **« Disponibilités »** dans `/admin/installation-bookings` : fermetures (plages datées + motif), fériés français listés et exclus, seuil « jour plein » — § 5.3 |
| Q5 | Annulation possible jusqu'à la **veille midi**, ensuite « appelez-nous » avec **WhatsApp** | Page « Votre rendez-vous » à jeton, règle J-1 12:00 Europe/Paris, boutons Appeler + WhatsApp après l'heure limite — § 5.2, § 7.6 |
| Q6 | Multi-véhicules, **1 véhicule = 2 h** | « Combien de véhicules ? » sur la page publique, créneau de `2 h × n`, une pose par véhicule à la validation — § 7.4 |
| Q7 | Supprimer tout ce qui est « test » ; options de suppression dans l'admin (lien, planning…) ; supprimer les plannings d'une société supprimée | Planning « TEST » **supprimé ce matin** ; la flotte « Client test » attend votre mot (§ 11) ; suppression d'un lien et d'un planning depuis l'admin (§ 8) ; la suppression d'une **société** n'existe pas dans Tracky — § 8.4 explique et propose |
| Q8 | À la suppression, s'il y a des demandes : demander « tout effacer » ou « conserver » | Dialogue à deux boutons, et les demandes conservées survivent au lien (§ 8.1) |

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

Tracky n'a **aucune** route pour créer ou supprimer une flotte lui-même : seul Manager le fait (`InternalSecretGuard`,
en-tête `X-Internal-Secret`). Tracky sait suspendre/réactiver une flotte sur ordre de Manager, et synchronise le statut
des comptes vers Vizyo Auth (`AuthAccountSyncService`, réparé le 02/08).

### 1.2 Les défauts trouvés (à corriger dans ce chantier, côté Tracky et côté Manager)

| # | Où | Défaut | Preuve | Correction |
|---|---|---|---|---|
| C1 | Manager → Tracky | **`clientId` n'est jamais envoyé** : `provisionTrackyFleet()` accepte `clientId?` mais `create()` ne le passe pas. Tracky ne sait donc pas quelle flotte appartient à quel client Manager. | `select "clientId" from fleets` en prod : **vide sur les 5 flottes** | Manager envoie `clientId` ; Tracky le stocke (colonne déjà là) et l'affiche |
| C2 | Manager → Tracky | **Le prénom de l'admin reçoit le nom de la société** (`adminFirstName: dto.companyName`, pas de `lastName`). | Prod : « Administeur / A2R », « Administrateur / Anouar » — corrigés à la main après coup | Manager envoie prénom/nom du contact ; Tracky refuse un prénom vide |
| C3 | Tracky `provisionFleet` | **Ni transaction ni idempotence** : la flotte est créée, puis `user.create` peut échouer (e-mail déjà pris → P2002) → **flotte orpheline sans admin**, et Manager note seulement `tracky_provision_failed`. Rejouer crée une deuxième flotte. | Lecture du code | `$transaction` + contrôle d'unicité avant + idempotence par `(adminEmail)` : renvoyer la flotte existante |
| C4 | Manager | Un client `trackyEnabled = true` **sans** `trackyFleetId` (provision échouée) est **irréparable** : `activateTracky()` répond « already enabled ». | Lecture du code | `activateTracky()` accepte le cas `trackyEnabled && !trackyFleetId` (reprovisionner) |
| C5 | Manager | **Essai automatique Leads** pour tout client, y compris un client créé pour Tracky seul. | `autoTrialApps = ['LEADS']` | Essai selon les apps activées |
| C6 | Tracky | **Aucun e-mail d'accueil** : l'admin existe dans Tracky sans jamais en avoir été informé ; le mot de passe est transmis à la main ; le lien « mot de passe oublié » expire en **60 min**. | `forgotPassword()` : `expiresInMinutes: 60` | E-mail « Votre espace Tracky » + page « Choisir mon mot de passe » qui fabrique le jeton **au clic** (§ 2.4) |
| C7 | Tracky ↔ Manager | Deux niveaux de sécurité pour la même famille de routes : Tracky entrant = secret statique dans un en-tête ; Manager entrant = **HMAC + horodatage** (`InternalHmacGuard`). | Lecture du code | Hors chantier ; noté pour plus tard (aligner Tracky sur HMAC) |
| C8 | Tracky `createFleetUser` | Reçoit un **mot de passe en clair** choisi par Manager, rôle figé `VIEWER`. | Lecture du code | Hors chantier ; à remplacer par une invitation Tracky (le client choisit) |
| C9 | Tracky | L'**invitation** (`/accept-invite`) enregistre elle-même le compte Vizyo Auth : elle **ne peut pas** servir à un compte que Manager a déjà créé (409 puis 401 « autre mot de passe »). | `InvitationsService.accept()` | D'où le choix du § 2.4 : pas d'invitation pour un compte Manager, mais « choisir mon mot de passe » |

**Ce que ça impose à la conception :** Tracky ne crée pas de flotte tout seul (sinon Manager ne la connaît pas, la
facturation non plus, et la prochaine activation depuis Manager créerait un doublon). La société d'un prospect naît
**dans Manager**, déclenchée depuis Tracky ou à la main — et Tracky se contente de **rattacher** la flotte reçue.

---

## 2. Le parcours cible : du lien au client équipé

```
 Lien « prospect »            Demande               Validation                     Pose                    Accès
 (sans flotte, avec        (page publique :      (admin Tracky :             (planning → tâche par      (e-mail « Votre
  nom de société)     →     société, contact  →   rattacher une flotte    →   véhicule ; « Valider   →   espace Tracky »
                            e-mail + tél,          OU créer le client            la pose » provisionne      dès la validation,
                            véhicules × 2 h)       via Manager)                  véhicule + boîtier)        rappel à la pose)
```

### 2.1 Le lien « prospect »
- Formulaire admin : « Société » devient un sélecteur dont la première entrée est **« Pas encore de compte flotte
  (prospect) »**. Ce choix révèle **« Nom de la société * »** ; les autres réglages ne changent pas.
- La page publique affiche `companyName` (prospect) ou `fleet.name`.
- Le lien porte **qui l'a créé** (« créé par Youness H. le 16/09 »).

### 2.2 La demande (page publique)
Contact **obligatoire** : nom, e-mail, téléphone (+ société si le lien est générique et sans flotte, + adresse de pose).
Véhicules : « Combien de véhicules ? » (1 à `maxVehicles` du lien, défaut 3) → la grille propose des créneaux de
`slotMinutes × n` ; une ligne par véhicule (plaque si connue, marque/modèle, énergie). Le client reçoit **immédiatement**
un accusé de réception avec le récapitulatif et son lien « Votre rendez-vous » (§ 5.2).

### 2.3 La validation (admin)
L'écran « Valider » d'une demande **sans flotte** propose deux chemins :
1. **Rattacher une flotte existante** (sélecteur) — pour un client déjà créé dans Manager ;
2. **Créer le client dans Vizyo Manager** — voir les deux variantes ci-dessous.

Puis, comme aujourd'hui : planning (créé s'il n'existe pas, nommé d'après la **société**), **une tâche par véhicule**
(plaque « à confirmer à la pose » si inconnue), notes du client → notes terrain, adresse et créneau visibles sur la tâche.
Le lien hérite de la flotte pour les demandes suivantes.

**Variante A — un clic, Manager en coulisse (recommandée, § 11 Q9).** Tracky appelle un nouveau point d'entrée de
Manager, `POST /internal/clients` (guard HMAC existant, appli `tracky` ajoutée à `INTERNAL_ALLOWED_APPS`), avec
`{ companyName, email, notificationEmail: email, contactFirstName, contactLastName, phone, trackyEnabled: true,
trackyFleetName, origin: 'tracky-rdv', externalRef: bookingId }`. Manager exécute **exactement** son `create()` habituel
(Auth Manager + Leads + Tracky, provision de la flotte, client) et répond `{ clientId, trackyFleetId }`. Tracky rattache.
Si Manager est injoignable : la validation s'arrête proprement (« Manager ne répond pas, réessayez ») — **jamais de
demi-client**. Côté Manager, `create()` corrige C1, C2, C4, C5 au passage.

**Variante B — deux gestes, aucun code Manager.** Bouton « Créer dans Vizyo Manager » (ouvre Manager avec le formulaire
prérempli par l'URL : société, e-mail, Tracky activé), puis « Actualiser les flottes » dans Tracky et rattachement.
Zéro risque, mais deux allers-retours.

### 2.4 L'accès du client (Q2)
Le compte admin existe dès la provision (créé par Manager, mot de passe généré que le client ne connaît pas). Tracky
envoie à la validation l'e-mail **« Votre espace Tracky est prêt »** (nouveau modèle `installation_access`) avec un bouton
**« Choisir mon mot de passe »** → page `app-tracky/bienvenue?e=<email>` qui, **au clic**, appelle `forgot-password`
(jeton Vizyo Auth de 60 min fabriqué à ce moment-là, pas à l'envoi) et affiche « Un lien valable une heure vient de vous
être envoyé ». L'e-mail d'accueil reste donc valable indéfiniment, et le jeton court n'est jamais périmé quand on s'en
sert. Le même bouton est repris dans l'e-mail de fin de pose (§ 6). Aucune invitation Tracky n'est envoyée (C9).

---

## 3. Modèle de données

Toutes les migrations sont **additives** (colonnes nullables ou avec défaut, nouvelles tables) : l'image précédente
lit encore chaque table → le repli `--repli` reste possible. Les colonnes rendues obsolètes sont conservées une
version, documentées « obsolète », puis retirées dans un chantier ultérieur.

### 3.1 `installation_booking_links`
| Champ | Changement | Pourquoi |
|---|---|---|
| `fleetId` | devient **nullable** (relation `Fleet?`, cascade conservée) | lien prospect |
| `companyName String?` | nouveau | nom affiché quand il n'y a pas de flotte ; obligatoire si `fleetId` est nul (règle service) |
| `createdBy` | gagne une **relation** `creator User?` (`onDelete: SetNull`) | « créé par … » |
| `maxVehicles Int @default(3)` | nouveau | plafond du multi-véhicules par lien |
| `slotMinutes` | inchangé (120) — c'est la durée **par véhicule** | Q6 |

### 3.2 `installation_bookings`
| Champ | Changement | Pourquoi |
|---|---|---|
| `linkId` | **nullable**, `onDelete: SetNull` (était Cascade) | Q8 « conserver les demandes » |
| `linkLabel String?` | nouveau, recopié à la création | lisible après suppression du lien |
| `fleetId` | **nullable** | demande d'un prospect |
| `companyName String?` | nouveau (du lien, ou saisi) | |
| `vehicleCount Int @default(1)` | nouveau | multi-véhicules ; `endAt = startAt + slotMinutes × vehicleCount` |
| `clientPhone` | reste `String?` en base, **obligatoire par le service** (E.164) | Q3 — pas de contrainte SQL pour ne pas casser d'anciennes lignes |
| `manageTokenHash String? @unique` | nouveau | page « Votre rendez-vous » (annuler / déplacer) |
| `cancelledAt DateTime?`, `cancelledBy String?` (`'client'` ou id utilisateur), `cancelReason String?` | nouveaux | R2 |
| `confirmedBy` | relation `confirmer User?` | « validée par … » |
| `reminderSentAt DateTime?` | nouveau | rappel J-1 envoyé une fois |
| `taskId` | **obsolète** (le lien passe par `installation_tasks.bookingId`) — conservé, plus écrit | multi-véhicules |
| `vehiclePlate/Brand/Model/Energy` | **obsolètes** — conservés, plus écrits (les véhicules vivent dans la table 3.3) | |

### 3.3 `installation_booking_vehicles` (nouvelle)
`id`, `bookingId` (cascade), `position Int`, `plate String?`, `brand String?`, `model String?`, `energy InstallationEnergy?`,
`taskId String? @unique` (la pose créée à la validation, `SetNull`).

### 3.4 `installation_tasks`
| Champ | Changement | Pourquoi |
|---|---|---|
| `bookingId String?` (+ index) | nouveau, `onDelete: SetNull` | plusieurs poses par demande ; l'éditeur affiche créneau, téléphone, adresse, notes de la demande |
| `plate` | reste obligatoire en base ; la validation écrit **« À confirmer »** si inconnue, et `completeTask` exige une vraie plaque | R9 |

### 3.5 `installation_closures` (nouvelle) — Q4
`id`, `startDate @db.Date`, `endDate @db.Date`, `label String`, `createdBy` (relation `User?`), `createdAt`.
Index sur `(startDate, endDate)`. Une fermeture couvre des **jours entiers**.

### 3.6 Réglages (nouveau, une ligne) — `installation_settings`
`id` (singleton), `maxManualTasksPerDay Int @default(3)` (seuil « jour plein »), `holidaysEnabled Boolean @default(true)`
(fériés exclus), `cancelDeadlineHour Int @default(12)` (heure limite de la veille), `updatedBy`, `updatedAt`.
Le téléphone et le WhatsApp de l'atelier restent en variables d'environnement (`INSTALLATION_PUBLIC_PHONE`,
`INSTALLATION_PUBLIC_WHATSAPP`), décision du 16/08 : jamais un numéro de personne. ⚠️ Les deux sont **vides en prod**.

### 3.7 `fleets`
`clientId` (existant, vide) est **renseigné par Manager** (C1) ; `origin String?` nouveau (`'manager'`, `'seed'`) — lecture seule.

---

## 4. API

### 4.1 Public (`/api/public/booking`, hors auth, débit borné)
| Route | Changement |
|---|---|
| `GET :token` | + `companyName`, `maxVehicles`, `contact: { phoneRequired: true }`, `atelier: { phone, whatsapp }`, `annulation: { heureLimite }` |
| `POST :token` | + `vehicleCount`, `vehicles[]`, `companyName?`, **`clientPhone` obligatoire** ; renvoie `manageUrl` |
| `GET :token/demande/:manageToken` | nouveau — la page « Votre rendez-vous » : créneau, statut, `peutAnnuler`, `peutDeplacer`, contacts atelier |
| `POST :token/demande/:manageToken/annuler` | nouveau — jusqu'à J-1 `cancelDeadlineHour` ; après → 409 avec `{ appelezNous: true }` |
| `POST :token/demande/:manageToken/deplacer` | nouveau — nouveau `startAt` ; même règle horaire ; une demande confirmée repasse **PENDING** (poses retirées), l'opérateur est prévenu |

### 4.2 Admin (`/api/installation-bookings`, SUPER_ADMIN)
| Route | Changement |
|---|---|
| `POST links` | `fleetId` optionnel, `companyName`, `maxVehicles` |
| `DELETE links/:id?demandes=conserver\|effacer` | Q8 — `conserver` : les demandes gardent `linkLabel`, `linkId → null` ; `effacer` : cascade (demandes, véhicules, visites, abonnés) ; sans paramètre et s'il existe des demandes → **409** avec le décompte (le dialogue s'en sert) |
| `POST :id/confirm` | + `fleetId` **ou** `creerClient: { … }` (variante A) ; crée `n` poses ; refuse sans flotte |
| `POST :id/cancel` | nouveau — statut `CANCELLED`, poses non faites supprimées, créneau libéré, e-mail optionnel |
| `POST :id/reschedule` | nouveau — `startAt` ; contrôle de disponibilité ; poses replanifiées |
| `GET closures` / `POST closures` / `DELETE closures/:id` | nouveaux (Q4) |
| `GET settings` / `PATCH settings` | nouveaux (§ 3.6) |
| `GET holidays?year=` | nouveau — les fériés français calculés (`date-holidays`, déjà en dépendance) |

### 4.3 Plannings (`/api/installations`)
- `PATCH :id/reorder` (FLEET_ADMIN) : **refuse** de déplacer une tâche portant `bookingId` (« ce créneau a été réservé
  par le client ; déplacez la demande depuis les réservations »).
- `DELETE :id/tasks/:taskId` : si la tâche porte `bookingId`, la demande est **annulée** dans le même mouvement (R2/P5).
- `POST :id/tasks/:taskId/complete` : une tâche issue d'une demande déclenche l'e-mail de fin de pose (§ 6) quand
  **toutes** les poses de la demande sont faites.
- Le DTO d'une tâche gagne `booking: { startAt, endAt, clientPhone, clientAddress, notes } | null`.

### 4.4 Interne (`/api/internal`) — C1, C3
- `POST fleet/provision` : `clientId`, `adminFirstName`, `adminLastName` ; **transaction** ; idempotent par `adminEmail`
  (renvoie `{ fleetId, existed: true }` si l'admin existe déjà avec sa flotte).

### 4.5 Manager (variante A) — `vizyo-manager-api`
- `POST /internal/clients` (guard `InternalHmacGuard`, appli `tracky`) → `clients.create()` ; `INTERNAL_ALLOWED_APPS += tracky`,
  `VIZYO_TRACKY_APP_SECRET` posé côté Manager, et côté Tracky les variables `MANAGER_INTERNAL_URL` / `MANAGER_APP_ID` /
  `MANAGER_APP_SECRET`.
- `create()` : passe `clientId` et prénom/nom du contact à la provision (C1, C2) ; `activateTracky()` reprovisionne un
  client sans `trackyFleetId` (C4) ; essai automatique limité aux apps activées (C5).

---

## 5. Écrans

### 5.1 Page publique `/book/:token`
- En-tête : société (`companyName` ou flotte), pastille « week-end possible », « créneaux de 2 h par véhicule ».
- **Étape 0 — Combien de véhicules ?** boutons 1 … `maxVehicles` (par défaut 1). Change la durée affichée des créneaux
  (« 09:00 – 13:00 · 2 véhicules ») et la grille (seuls les départs où `n` créneaux consécutifs sont libres).
- Étapes 1–2 inchangées (jour, créneau).
- **Étape 3 — Vos informations** : Nom *, E-mail *, Téléphone * (aide : « nous vous appelons la veille »), Société * si
  lien prospect générique, Adresse de pose *, puis **une ligne par véhicule** (plaque « si vous la connaissez », marque /
  modèle, énergie), remarque.
- Validation : e-mail syntaxe + minuscule, téléphone → E.164 (`toE164`, aide au format 06… → +33), adresse non vide.
- Après envoi : « Demande envoyée » + « Un e-mail de confirmation vient de partir, il contient le lien pour modifier
  ou annuler ». Les sorties (appeler, WhatsApp, prévenez-moi, autre créneau) et « Découvrir Tracky » restent.
- Lien fermé/introuvable : sorties **Appeler** + **WhatsApp** (si configurés) + e-mail.

### 5.2 Page « Votre rendez-vous » `/book/:token/demande/:manageToken`
- Récapitulatif (créneau, véhicules, adresse, statut : en attente / confirmé / annulé / posé).
- **Avant J-1 12:00** : « Déplacer » (rouvre la grille du lien) et « Annuler » (confirmation en deux temps, motif facultatif).
- **Après** : « Il est trop tard pour modifier en ligne » + boutons **Appeler l'atelier** et **WhatsApp**
  (`https://wa.me/<numéro>?text=<message prérempli : société, créneau>`).
- Toujours : « Découvrir Tracky », et le bouton « Choisir mon mot de passe » si l'accès a été créé.

### 5.3 Admin `/admin/installation-bookings`
- **Demandes** : carte enrichie (société, `n` véhicules, téléphone cliquable, « validée par … », statut « posée x/n ») ;
  actions **Valider** (avec l'écran de rattachement § 2.3), **Refuser** (e-mail réparé), **Annuler** (nouveau),
  **Déplacer** (nouveau : grille du lien).
- **Liens** : « Société : prospect · Nom X », « créé par … le … », `maxVehicles`, bouton **Supprimer** → dialogue Q8 :
  « Ce lien porte 2 demandes (1 en attente). — Conserver les demandes / Tout effacer / Annuler » (les conséquences
  chiffrées, comme le dialogue de suppression d'un planning).
- **Agenda** : fusionne **demandes** (créneaux) et **poses manuelles** (jour) — la « journée de l'installateur » ;
  chaque ligne : heure ou « journée », société, adresse, téléphone, véhicules.
- **Disponibilités** (nouvel onglet, Q4) : fermetures (liste + formulaire du … au … + motif), fériés à venir (calculés,
  case « exclure les fériés » cochée), seuil « jour plein : N poses manuelles » ; rappel des numéros d'atelier et de
  leur variable d'environnement.

### 5.4 Plannings `/admin/installations/:id` et `/installations` (client)
- Une tâche issue d'une demande affiche un encart **« Réservé en ligne : jeu. 17 sept. 10:00 – 12:00 · 06 … · 12 rue …
  · note du client »** et un cadenas côté client (non déplaçable).
- Le planning créé automatiquement porte le nom de la **société** et la description « Prises de RDV en ligne — créé
  automatiquement à la validation ».

---

## 6. Courriels et notifications

| Modèle (nouveau sauf mention) | À qui | Quand | Contenu clé |
|---|---|---|---|
| `installation_slot_received` | client | à la demande | récap (créneau, véhicules), « nous confirmons sous 24 h », lien « Votre rendez-vous » |
| `installation_slot_requested` (existant) | opérateur | à la demande | + société, téléphone, `n` véhicules, prospect ou flotte |
| `installation_slot_confirmed` (existant, enrichi) | client | validation | + pièce **`.ics`**, lien « Votre rendez-vous », règle J-1 12:00, Appeler / WhatsApp |
| `installation_access` | client (prospect) | validation | « Votre espace Tracky est prêt » + **Choisir mon mot de passe** (§ 2.4) |
| `installation_slot_rejected` (remplace le mail illisible, R1) | client | refus | motif, « Choisir un autre créneau » si le lien est ouvert, Appeler / WhatsApp |
| `installation_slot_cancelled` | client ou opérateur | annulation | qui a annulé, quand, comment reprendre |
| `installation_reminder` | client | **J-1 vers 10:00** (e-mail + SMS si téléphone) | créneau, adresse, « pour modifier : avant midi » |
| `installation_done` | client | dernière pose de la demande faite | « Vos véhicules sont équipés » + Choisir mon mot de passe + Découvrir Tracky |
| Push super-admins | opérateur | nouvelle demande, annulation client | socle notifications (`CoupeCircuitPushService` en modèle) |

Chaque modèle passe par les cinq points de câblage (union, builder, aperçu, catalogue, deux specs). L'adresse opérateur
sort du code (`INSTALLATION_NOTIFY_EMAIL`, défaut `contact@vizyoagency.com`).

---

## 7. Règles métier (toutes côté serveur, testées)

1. **Jamais le jour même** : premier jour `J+leadDays` (≥ 1) — en prod depuis le 15/09.
2. **Jours fermés** : fériés français (`date-holidays` `FR`, déjà en dépendance) si `holidaysEnabled` ; fermetures
   (§ 3.5) ; **jour plein** = `≥ maxManualTasksPerDay` tâches manuelles `PENDING` planifiées ce jour.
3. **Occupation** : demandes `PENDING`/`CONFIRMED` (contrainte EXCLUDE existante, capacité 1 équipe, inchangé).
4. **Multi-véhicules** : durée `slotMinutes × n` ; un départ n'est proposé que si les `n` créneaux consécutifs sont libres
   et tiennent dans la fenêtre du jour (samedi 09–13 = 2 véhicules au plus). `n ≤ maxVehicles` du lien.
5. **Contact** : e-mail et téléphone obligatoires ; téléphone stocké en E.164 ; un lien nominatif (client connu) pré-remplit
   mais laisse corriger.
6. **Annulation / déplacement par le client** : autorisés jusqu'à **J-1 à `cancelDeadlineHour`** (12:00 Europe/Paris) ;
   après : refus + Appeler / WhatsApp. Une demande confirmée déplacée repasse `PENDING` et ses poses sont retirées.
7. **Annulation par l'opérateur** : à tout moment ; poses non faites retirées ; pose faite → refus (« la pose a eu lieu »).
8. **Usage unique** : le lien se ferme dès la **demande** ; il rouvre si elle est refusée ou annulée (R10).
9. **Suppression d'une pose liée** → la demande est annulée (P5) ; **suppression d'un planning** → idem pour chacune.
10. **Sans flotte, pas de validation** : rattacher ou créer (§ 2.3) ; jamais de planning sans flotte.

---

## 8. Suppressions (Q7, Q8)

### 8.1 Un lien
Dialogue avec les conséquences chiffrées : *« Ce lien porte 3 demandes (1 en attente, 2 confirmées), 4 visites, 1 abonné. »*
- **Conserver les demandes** : les demandes restent (statut inchangé, `linkLabel` gardé), visites et abonnés effacés.
- **Tout effacer** : demandes (et leurs véhicules), visites, abonnés — les poses déjà créées survivent (SetNull), sauf
  si l'on coche « retirer aussi les poses non faites ».
- Sans demande : suppression directe (une confirmation simple).

### 8.2 Un planning
Existant (dialogue avec le nombre de lignes). Ajout : les demandes liées sont **annulées** et le client prévenu si la case
« prévenir les clients » est cochée.

### 8.3 Une demande
Pas de suppression : une demande s'**annule** (trace conservée). La purge des demandes anciennes (annulées / refusées
de plus de 12 mois) rejoint l'entretien quotidien.

### 8.4 Une société
Tracky **n'a pas** de suppression de flotte : Manager la suspend (kill-switch) ou la réactive, et rien ne l'efface. C'est
sain (une flotte porte véhicules, positions, trajets, comptes). Si vous voulez « supprimer une société », je propose un
**archivage** (flotte masquée partout, comptes suspendus, plannings et liens fermés) plutôt qu'un `DELETE` en cascade —
à trancher (§ 11 Q12). En attendant, les plannings d'une flotte supprimée en base partent déjà avec elle (cascade).

---

## 9. Ce qui est nettoyé au passage (code obsolète, textes faux)

- `rejectBooking` : mail illisible et mauvais identifiant → modèle `installation_slot_rejected`.
- Texte du dialogue de suppression d'un lien (« conservées ») → remplacé par le dialogue § 8.1.
- `CONTACT_EMAIL` en dur → `INSTALLATION_NOTIFY_EMAIL`.
- `InstallationBooking.taskId` / `vehicle*` : marqués obsolètes (retrait au chantier suivant, après une version en prod).
- `leadHours` (déjà obsolète depuis le 14/09) : retirée au même chantier suivant.
- Libellé « Usage unique (se ferme après la 1ʳᵉ réservation) » rendu vrai (§ 7.8).
- `provisionFleet` : transaction + idempotence + prénom/nom + `clientId` (C1–C3).

---

## 10. Lots, ordre, effort, vérification

| Lot | Contenu | Effort | Déploiement |
|---|---|---|---|
| **A — le socle** | modèle 3.1–3.4, 3.7 ; lien prospect + créateur ; contact obligatoire ; multi-véhicules ; validation avec rattachement (variante B d'abord, A si Q9 = oui) ; annulation opérateur ; refus réparé ; suppression Q8 ; `provisionFleet` C1–C3 | 2 j | Tracky seul (variante B) ; + Manager (variante A) |
| **B — le calendrier** | fermetures + fériés + jour plein + onglet Disponibilités ; poses liées (encart, verrou, annulation en cascade) ; agenda fusionné | 1,5 j | Tracky |
| **C — le client** | page « Votre rendez-vous » (annuler / déplacer, J-1 12:00, WhatsApp) ; accusé, `.ics`, rappel J-1 (e-mail + SMS), fin de pose, accès (§ 2.4) ; push opérateur | 1,5 j | Tracky ; variables `INSTALLATION_PUBLIC_PHONE` / `_WHATSAPP` à poser en prod |
| **D — Manager** | `POST /internal/clients`, C1, C2, C4, C5 | 0,5 j | Manager (autre dépôt, son propre déploiement) |

Chaque lot : branche, tests unitaires (générateur, service, DTO), recette sur la base de dev avec un lien de test,
`pnpm verify`, puis `deploy.sh --attendre` hors fenêtre de preuve du chantier coupe-circuit. Après chaque déploiement :
migration appliquée, artefact vérifié dans le conteneur, un lien de test créé **puis supprimé**.

**Risques nommés** : (1) la variante A touche Manager — à tester contre un Vizyo Auth de recette avant la prod ;
(2) rendre `linkId` et `fleetId` nullables élargit les `where` — chaque requête qui filtrait par `fleetId` est relue ;
(3) le rappel SMS coûte (les SMS +34 facturés du chantier coupe-circuit) — désactivable par réglage.

---

## 11. Reste à trancher

| # | Question | Mon conseil |
|---|---|---|
| **Q9** | Création du client : **variante A** (un clic, Manager modifié) ou **variante B** (deux gestes, Manager intact) ? | A, avec B livrée d'abord comme filet : B est incluse dans A. |
| **Q10** | La flotte **« Client test »** (2 véhicules `TEST-00x-XX`, votre compte admin) : la garder comme flotte de recette, ou la supprimer ? | La garder, renommée « Recette Vizyo » — un lien de test doit bien vivre quelque part. |
| **Q11** | Numéros d'atelier à publier : téléphone et WhatsApp = **06 52 07 70 38** (déjà public sur la vitrine) ? | Oui pour les deux, posés dans `.env.prod`. |
| **Q12** | « Supprimer une société » : un **archivage** (mon conseil) ou un effacement en cascade ? | Archivage ; l'effacement définitif reste une opération manuelle et exceptionnelle. |
| **Q13** | Le rappel J-1 par **SMS** en plus de l'e-mail (coût) ? | Oui, désactivable dans Disponibilités. |
