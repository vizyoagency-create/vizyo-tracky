# Sprint 7 — Gestion/maintenance + agenda — ANALYSE (Phase 1)

> Cartographie du réel (3 explorations) + conception du **modèle d'événement générique** (fondation S8). Branche `feat/sprint-7-gestion-maintenance`. LOCAL.
> **STOP en fin de doc** : valider le modèle générique + les points d'extension S8 avant d'implémenter. C'est le point structurant du sprint.

---

## 0. Décision centrale

L'agenda n'est **pas** un calendrier de maintenance jetable : c'est un **modèle d'événement générique et typé sur la timeline d'un véhicule**, que **Sprint 8 (réservations) réutilisera tel quel**. Deux choix structurants :

1. **Un nouveau modèle générique `VehicleEvent`** (type + catégorie + statut + ancrage temporel + métadonnées) porte **maintenance + incident** maintenant, **réservation/usage** plus tard — **sans refonte**.
2. **On NE fond PAS l'agenda dans le modèle `Alert` existant.** `Alert` = alarmes télémétriques temps-réel (excès vitesse, SOS, surveillance) avec son moteur d'escalade/dispatch. L'agenda = items **planifiés/gérés** avec cycle de vie (prévu → en cours → résolu). Les garder séparés évite un refactor risqué d'`Alert` (« ne rien casser ») **et** réutilise quand même l'infra de notification (cf. §5).

---

## 1. État de l'existant (ce qui manque / ce qui se réutilise)

| Brique | Constat | Verdict |
|---|---|---|
| **Modèle `Vehicle`** (`schema.prisma:315`) | fleetId, plate, type, brand/model/year, fuelConsumptionL100km, currentDriver, tracker… **AUCUN champ maintenance** (ni odomètre, ni date entretien/CT). | **Ajouter** un baseline km + créer les modèles agenda. |
| **Source kilométrage** | `Trip.distanceKm` agrégeable (`SUM` déjà fait dans `reports-stats`). Pas de total stocké. Pas d'odomètre Coban. | **Dérivable** (indicatif), **non autoritaire** (cf. §6). |
| **Infra notifications** (`apps/api/src/notifications/`) | **RICHE** : `NotificationDispatchService` (multi-canal IN_APP/WEB_PUSH/EMAIL/WHATSAPP/SMS, routage par `AlertRule`), `WebPushService` (VAPID), `EscalationCronService`. | **Réutiliser** pour les rappels (cf. §5). |
| **Récurrence** (`vehicle-schedules`) | `VehicleSchedule` = **temps seulement** (créneaux hebdo + jours fériés). Pas adapté « tous les X mois/km ». Le **pattern cron** (`ScheduleCronService` : @Cron/minute + verrou + evaluate-all) est réutilisable. | **Nouveau** modèle de récurrence maintenance + **réutiliser le pattern cron**. |
| **Groupes (S1)** | Filtre `selectedGroupId` + `groupOptions` (vehicles/reports), `GroupBadgeComponent`. | **Réutiliser** pour filtrer l'agenda. |
| **Scoping tenant** | `resolveTenantScope` (fail-closed), `VehicleAccessService.getAccessibleVehicleIds` (ALL/GROUP/VEHICLE, mémoïsé), `resolveReportVehicleScope` (anti-IDOR, S5). | **Réutiliser tel quel** (cf. §8). |
| **Calendrier** | **Aucun** composant calendrier. Pas de date-fns/dayjs (Date natif). `DateRangePickerComponent` a déjà les helpers de grille mensuelle. | **Construire** la grille mois (Date natif, helpers réutilisés). |
| **Design system / perms** | Tokens, `.s-card`, `GroupBadge`, dropdowns, lucide `Calendar`, `permissionGuard`, `UserPermissions` (packages/shared). | **Réutiliser** + ajouter 2 perms. |

---

## 2. ⭐ Le modèle d'événement générique — `VehicleEvent` (le cœur)

Un événement = une chose **datée, typée, avec un statut**, sur la timeline d'un véhicule. Générique par construction :

```prisma
enum VehicleEventType {
  MAINTENANCE        // entretien (vidange, CT, révision, pneus, garage…)
  INCIDENT           // signalement / panne (porte, voyant huile…)
  RESERVATION        // (S8) réservation/booking — STUB documenté, non câblé en S7
}

enum VehicleEventStatus {
  PLANNED            // prévu / à venir (échéance future)
  OPEN               // ouvert / à traiter (incident signalé, échéance due)
  IN_PROGRESS        // en cours (au garage, en réparation, en usage)
  DONE               // réalisé / résolu
  CANCELLED          // annulé
}

model VehicleEvent {
  id            String   @id @default(uuid()) @db.Uuid
  fleetId       String   @db.Uuid            // tenant — scoping/filtrage (dénormalisé)
  vehicleId     String   @db.Uuid            // tout événement agenda est rattaché à un véhicule

  type          VehicleEventType
  category      String?                      // sous-type LIBRE, extensible SANS migration :
                                             // 'OIL_CHANGE','TECHNICAL_INSPECTION','TIRES','REVISION','DOOR_ISSUE','OIL_LIGHT'…
  status        VehicleEventStatus @default(PLANNED)
  severity      String?                      // incidents : 'LOW'|'MEDIUM'|'HIGH' (optionnel)

  title         String                       // "Vidange", "Porte AVG ferme mal"
  description   String?

  startAt       DateTime                     // ANCRAGE TEMPOREL générique (échéance/réalisation/début) — index calendrier
  endAt         DateTime?                    // plage (garage du X au Y ; créneau réservation S8)
  allDay        Boolean  @default(true)      // maintenance = journée ; réservation S8 = créneau horaire

  odometerKm    Int?                         // km SAISI (autoritaire) au moment de l'événement
  planId        String?  @db.Uuid            // généré par un MaintenancePlan récurrent (§4)
  linkedEventId String?  @db.Uuid            // chaînage : incident → passage garage planifié

  resolvedAt    DateTime?
  metadata      Json?                        // extensible PAR TYPE sans migration (S8 : réservé par, motif, passagers…)

  createdBy     String   @db.Uuid            // user (ou système)
  source        String   @default("MANUAL")  // MANUAL | AUTO (dérivé) | SYSTEM (cron)

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([fleetId, startAt])
  @@index([vehicleId, startAt(sort: Desc)])
  @@index([fleetId, type, startAt])
  @@index([fleetId, status])
  @@map("vehicle_events")
}
```

**Pourquoi c'est générique (et pas « vidange/CT » en dur) :** le **type** est une petite enum stable (3 valeurs), le **category** est une string ouverte (n'importe quel sous-type, zéro migration), le **statut** couvre tous les cycles de vie, l'**ancrage temporel** est `startAt`+`endAt`+`allDay` (ponctuel OU plage OU créneau), et `metadata` (Json) absorbe tout champ spécifique futur. La vue calendrier lit **un seul modèle** et colore par `type`/`category`.

---

## 3. ⭐ Points d'extension Sprint 8 (réservation) — explicites

Le modèle est conçu pour que S8 **n'ait rien à refondre** :

1. **Nouveau type** : `RESERVATION` est déjà dans l'enum (stub). S8 le câble ; ajouter d'autres (`USAGE`, `UNAVAILABILITY`) = +1 valeur d'enum (migration triviale `ALTER TYPE ADD VALUE`, non bloquante).
2. **Créneaux horaires** : `startAt`/`endAt` + `allDay=false` portent nativement une réservation « de 14h à 16h ». Rien à ajouter.
3. **Champs spécifiques réservation** (qui réserve, motif, passagers, prix) → `metadata` (Json), **sans migration**.
4. **Cycle de vie réservation** : `PLANNED → IN_PROGRESS (en usage) → DONE`. Si S8 veut `CONFIRMED/REJECTED`, +1 valeur d'enum (additif).
5. **Détection de conflit / disponibilité** (cœur de S8) : requête d'overlap sur `(vehicleId, startAt, endAt)` — le modèle + l'index `@@index([vehicleId, startAt])` la supportent. **Point d'extension documenté** : un `VehicleEventService.findOverlaps(vehicleId, from, to)` (non implémenté S7) sera la base du moteur de réservation.
6. **Calendrier type-agnostique** : la vue rend `VehicleEvent` par `type`/couleur → les réservations s'affichent **sans refonte UI**.
7. **Filtre par type** : déjà prévu (filtre type dans l'agenda) → S8 ajoute juste « Réservations » à la liste des types.

→ S7 implémente MAINTENANCE + INCIDENT ; ces 7 points garantissent que S8 greffe la réservation sur la même base.

---

## 4. Récurrence + dérivation auto — `MaintenancePlan`

La récurrence (CT/vidange « tous les X mois/km ») est **spécifique maintenance** (S8 n'en a pas besoin) → modèle séparé qui **génère** des `VehicleEvent` de type MAINTENANCE :

```prisma
model MaintenancePlan {
  id              String   @id @default(uuid()) @db.Uuid
  fleetId         String   @db.Uuid
  vehicleId       String   @db.Uuid
  category        String                       // 'OIL_CHANGE','TECHNICAL_INSPECTION',…
  label           String
  intervalMonths  Int?                         // tous les N mois (l'un et/ou l'autre)
  intervalKm      Int?                         // tous les N km
  lastDoneAt      DateTime?                    // base du prochain calcul
  lastDoneKm      Int?
  reminderDaysBefore Int  @default(30)         // préavis (temps)
  reminderKmBefore   Int? @default(1000)       // préavis (km)
  enabled         Boolean @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([fleetId, vehicleId])
  @@map("maintenance_plans")
}
```

- **Prochaine échéance** = `lastDoneAt + intervalMonths` (et/ou `lastDoneKm + intervalKm`). Matérialisée en un `VehicleEvent` PLANNED (source=AUTO, planId) → visible dans le calendrier.
- **Quand l'entretien est réalisé** : on enregistre un `VehicleEvent` DONE (date + odometerKm) → ça met à jour `MaintenancePlan.lastDoneAt/lastDoneKm` → la prochaine échéance se recalcule. **Passé/réalisé (DONE) vs prévu (PLANNED)** distingués par le `status`.
- **Cron de rappel** (réutilise le pattern `ScheduleCronService` : @Cron + verrou + evaluate-all) : régénère les PLANNED + déclenche le rappel à l'approche du préavis (cf. §5).

---

## 5. Réutilisation des notifications (rappels « visibles/notifiés »)

- **Visible** : les `VehicleEvent` PLANNED/OPEN s'affichent dans l'agenda, **colorés par urgence** (à échéance = ambre, en retard = rouge) + un compteur dans la nav. C'est le rappel principal.
- **Notifié** : le cron de maintenance, quand une échéance franchit le préavis, **émet un `Alert` de type `MAINTENANCE_DUE`** (1 valeur ajoutée à l'enum `AlertType`) → qui passe par le `NotificationDispatchService` **existant** (web-push aux fleet-admins selon leurs `AlertRule`) + apparaît dans la page Alertes. **On réutilise tout le moteur de dispatch sans le réécrire**, et sans coupler l'agenda à `Alert` (l'Alert est juste le véhicule de notification ; la source de vérité agenda reste `VehicleEvent`).

---

## 6. Source du kilométrage — formule + fiabilité

- **Dérivé (indicatif)** : `SUM(Trip.distanceKm) WHERE vehicleId` (déjà calculé par `reports-stats`). Fiabilité **±3-5 %**, **sous-compte** si trajets manqués (offline/sampling). **Non autoritaire.**
- **Autoritaire** : odomètre **saisi** à la main lors d'un entretien (relevé garage) → `VehicleEvent.odometerKm` + dénormalisé sur `Vehicle.lastOdometerKm` / `lastOdometerAt` (nouveau, le baseline).
- **Km courant estimé** = `Vehicle.lastOdometerKm + SUM(Trip.distanceKm depuis lastOdometerAt)` → meilleur des deux mondes : baseline fiable + progression GPS. **Saisie auto-suggérée** (pré-remplie) mais **toujours corrigeable** par l'utilisateur.
- Les rappels km utilisent ce km estimé ; on documente clairement « estimation GPS » dans l'UI.

**Ajouts au modèle `Vehicle`** (additifs, non cassants) : `lastOdometerKm Int?`, `lastOdometerAt DateTime?` + relations `vehicleEvents`, `maintenancePlans`.

---

## 7. Signalements / incidents → agenda

- « Signaler un incident » (depuis la fiche véhicule) crée un `VehicleEvent` **type=INCIDENT, status=OPEN** (severity, title « Porte AVG ferme mal », description). Il **remonte dans l'agenda** (à sa date) et dans un volet « incidents ouverts ».
- Cycle : **OPEN → IN_PROGRESS → DONE** (résolu). Un incident peut être **chaîné** à un passage garage planifié (`linkedEventId` → un `VehicleEvent` MAINTENANCE) — « débouche sur un passage garage ».
- Même modèle, même calendrier (couleur distincte). **Qui peut signaler ?** → décision à valider (cf. §10).

---

## 8. Scoping tenant strict (anti-IDOR)

Tout `VehicleEvent`/`MaintenancePlan` porte `fleetId` + `vehicleId`. Les endpoints **réutilisent exactement** la chaîne S5 :
- `resolveTenantScope(user)` (fail-closed) pour la flotte ;
- `VehicleAccessService.getAccessibleVehicleIds(user)` + `resolveReportVehicleScope(accessible, requested?)` → un user scopé groupe/véhicule ne voit/édite **que** ses véhicules ; un `vehicleId` hors périmètre → **403**.
- L'agenda filtré par groupe (S1) passe par ce même périmètre.

---

## 9. Risques

1. **Sur-conception S8** → mitigé : on n'implémente que maintenance + incident ; `RESERVATION` est un stub, le moteur de réservation/conflit est **documenté mais pas codé**.
2. **Fiabilité km** → odomètre manuel autoritaire + GPS indicatif clairement étiqueté.
3. **Ne rien casser** → nouveaux modèles/écran isolés ; fiche véhicule = **+1 onglet** (Maintenance) + 1 action, sans toucher l'existant ; `Alert` non modifié (sauf +1 valeur d'enum `MAINTENANCE_DUE`).
4. **Calendrier from-scratch** → réutilise les helpers `DateRangePicker` (éprouvés), périmètre mois simple, mobile-first.

---

## 🛑 STOP — à valider avant Phase 2 (PLAN)
1. **Le modèle générique `VehicleEvent`** (type enum + category string + statut + startAt/endAt/allDay + metadata) comme fondation unique de l'agenda, **distinct d'`Alert`**. OK ?
2. **Les 7 points d'extension S8** (§3 : type RESERVATION, créneaux endAt/allDay, metadata, statut, requête de conflit, calendrier type-agnostique). OK ?
3. **`MaintenancePlan` séparé** pour la récurrence (mois/km) qui génère des `VehicleEvent`. OK ?
4. **Réutilisations** : rappels = `VehicleEvent` visibles + `Alert MAINTENANCE_DUE` via le dispatch existant ; km = baseline manuel + GPS indicatif ; scoping S5 ; calendrier from-scratch ; agenda générique nommé **/agenda** (2 perms `agenda_view`/`agenda_manage`). OK ?
5. **À trancher** : qui peut **signaler un incident** ? (proposition : tout user avec accès au véhicule, via `agenda_view` ; la gestion maintenance/plans = `agenda_manage`.)

Dès ton OK → `PLAN.md` (modèle détaillé + migrations, saisie auto/manuel, vue calendrier multi-types, signalements, rappels/cron, fichiers, tests, points d'extension S8).
