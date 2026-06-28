# Sprint 7 — Gestion/maintenance + agenda — PLAN (Phase 2)

> Suite de `ANALYSE.md`. Branche `feat/sprint-7-gestion-maintenance`. LOCAL.
> Décisions verrouillées : modèle générique **`VehicleEvent`** (distinct d'`Alert`) + **`MaintenancePlan`** (récurrence) ; permissions **`agenda_view`/`agenda_manage`** défaut **SUPER_ADMIN + FLEET_ADMIN** seulement, **accordables par utilisateur** dans l'espace perms ; signalement gated par `agenda_view`.

## Ordre d'implémentation (commits atomiques, vérifiables)
1. **Permissions** (shared) — socle (perms + défauts + labels).
2. **Migrations + modèles** : `VehicleEvent`, `MaintenancePlan`, champs `Vehicle`, `AlertType += MAINTENANCE_DUE`.
3. **Backend agenda — cœur générique** : CRUD `VehicleEvent` + scoping (anti-IDOR) + endpoints calendrier. Tests.
4. **Backend maintenance** : `MaintenancePlan` + dérivation km + matérialisation des échéances + cron de rappel (Alert `MAINTENANCE_DUE` → dispatch existant). Tests.
5. **Front — agenda** : route `/agenda` + nav + calendrier multi-types + filtres (véhicule/groupe/type) + saisie.
6. **Front — fiche véhicule** : onglet Maintenance + « Signaler un incident ».
7. Vérif (typecheck + jest + build) + récap.

---

## 1. Permissions (`packages/shared/src/permissions/permissions.ts`)
- Ajouter à `UserPermissions` : `agenda_view` (voir l'agenda + **signaler un incident**), `agenda_manage` (créer/éditer/résoudre maintenance + plans + statuts).
- **Défauts** : `SUPER_ADMIN` = true/true ; `FLEET_ADMIN` (ADMIN_DEFAULTS) = true/true ; **`FLEET_MANAGER`, `VIEWER`, `NIGHT_WATCHMAN` = false/false**.
- `PERMISSION_LABELS` : groupe **« Agenda / Maintenance »** (2 labels) + ajout à `PERMISSION_GROUP_ORDER` → apparaissent **automatiquement** dans l'éditeur de permissions par utilisateur (l'espace user lit ces labels). Un fleet-admin accorde `agenda_view`/`agenda_manage` à un user précis.
- `PERMISSION_KEYS` est dérivé des défauts → pas de modif manuelle.

## 2. Modèle de données + migrations

**`VehicleEvent`** (le générique, cf. ANALYSE §2) + **`MaintenancePlan`** (récurrence, ANALYSE §4) — schémas validés. Plus :
- **`Vehicle`** (additif, non cassant) : `lastOdometerKm Int?`, `lastOdometerAt DateTime?` + relations `vehicleEvents VehicleEvent[]`, `maintenancePlans MaintenancePlan[]`.
- **`AlertType`** : `+ MAINTENANCE_DUE` (1 valeur d'enum — le rappel passe par l'`Alert`/dispatch existant). + label/icône côté UI alertes.
- **Migration** `add_agenda_events` : `CREATE TYPE` (VehicleEventType, VehicleEventStatus) + `CREATE TABLE vehicle_events, maintenance_plans` + `ALTER TABLE vehicles ADD lastOdometerKm/lastOdometerAt` + `ALTER TYPE "AlertType" ADD VALUE 'MAINTENANCE_DUE'`. Indexes cf. ANALYSE. (Tables neuves + colonnes nullables + valeur enum → **non bloquant**.)

## 3. Backend — module `agenda` (`apps/api/src/agenda/`)

Fichiers : `agenda.module.ts`, `vehicle-events.service.ts`, `vehicle-events.controller.ts`, `maintenance-plans.service.ts`, `maintenance-plans.controller.ts`, `maintenance-reminder.service.ts` (cron), `odometer.service.ts` (dérivation km). Réutilise `VehicleAccessService`, les helpers de scope, `NotificationDispatchService`, `PrismaService`.

**Scoping (anti-IDOR, identique S5) sur TOUT endpoint** :
```
scope = resolveTenantScope(user)              // fail-closed flotte
accessible = getAccessibleVehicleIds(user)    // ALL | [ids]
resolveReportVehicleScope(accessible, [vehicleId?])  // 403 si hors périmètre
where = { fleetId, vehicleId∈périmètre }
```

**Endpoints** (préfixe `/agenda`) :
| Méthode | Route | Perm | Rôle |
|---|---|---|---|
| GET | `/agenda/events?from&to&vehicleId?&groupId?&type?&status?` | `agenda_view` | liste calendrier (scopée) |
| POST | `/agenda/incidents` | `agenda_view` | **signaler un incident** (type=INCIDENT, status=OPEN) |
| POST | `/agenda/events` | `agenda_manage` | créer un événement maintenance/manuel |
| PATCH | `/agenda/events/:id` | `agenda_manage` | éditer / changer statut / résoudre |
| DELETE | `/agenda/events/:id` | `agenda_manage` | suppression (soft si besoin) |
| GET | `/agenda/plans?vehicleId?` | `agenda_view` | plans de maintenance (scopés) |
| POST/PATCH/DELETE | `/agenda/plans/:id?` | `agenda_manage` | gérer la récurrence |
| GET | `/agenda/vehicles/:id/odometer` | `agenda_view` | km estimé (pré-remplissage saisie) |
| GET | `/agenda/summary?from&to` | `agenda_view` | compteurs (à venir / en retard / ouverts) pour badge nav |

- `GET /events` borné dans le temps (`from`/`to`, défaut le mois affiché) → pas de scan illimité ; index `(fleetId, startAt)`.
- Filtre **groupe** = résoudre les `vehicleId` du groupe (via S1, scopé) puis `vehicleId in [...]`.

## 4. Saisie — auto + manuel

- **Manuel** : `POST /agenda/events` (maintenance réalisée/prévue) ou `/agenda/incidents`. Form : véhicule, type, catégorie, titre, date(s), odomètre, sévérité, description.
- **Auto — km** : `OdometerService.estimate(vehicleId)` = `Vehicle.lastOdometerKm + SUM(Trip.distanceKm depuis lastOdometerAt)` → **pré-remplit** le champ km à la saisie (étiqueté « estimation GPS », corrigeable). À l'enregistrement d'un événement avec `odometerKm`, on met à jour `Vehicle.lastOdometerKm/At` (nouveau baseline autoritaire).
- **Auto — prochaine échéance** : à la création/MAJ d'un `MaintenancePlan` ou à l'enregistrement d'un entretien DONE → (re)calcul de `nextDue` (date = `lastDoneAt + intervalMonths` ; km = `lastDoneKm + intervalKm`) → **matérialisé en un `VehicleEvent` PLANNED** (source=AUTO, planId). **Passé/réalisé (DONE) vs prévu (PLANNED)** = le `status`.

## 5. Rappels (visibles + notifiés) — `MaintenanceReminderService`
- **Cron** (pattern `ScheduleCronService` : `@Cron` quotidien + verrou anti-overlap + try/catch). Pour chaque `MaintenancePlan` activé : recalcule l'échéance, (re)matérialise le `VehicleEvent` PLANNED, et **si dans le préavis** (`reminderDaysBefore` ou km estimé ≥ seuil) et pas déjà notifié → **crée un `Alert(MAINTENANCE_DUE, vehicleId, severity=WARNING)`**.
- L'`Alert` passe par le **`NotificationDispatchService` existant** → web-push aux fleet-admins (recipients par défaut même sans `AlertRule`) + visible dans la page Alertes. **Zéro réécriture du moteur de notif.**
- **Visible** dans l'agenda : les PLANNED/OPEN colorés par urgence (à échéance = ambre, en retard = rouge) + `GET /agenda/summary` alimente un **badge compteur** dans la nav.

## 6. Front — Agenda (`apps/web/src/app/features/agenda/`)
- **Route** `/agenda` (`permissionGuard('agenda_view')`) + **nav item « Agenda »** (icône lucide `Calendar`) dans `dashboard-layout.navItems` (gated `perms.can('agenda_view')`). Pas dans la bottom-bar mobile (sidebar/More).
- **`AgendaComponent`** (standalone, signals, OnPush) :
  - **Calendrier mois** `AgendaCalendarComponent` construit **from-scratch** (Date natif, helpers repris de `DateRangePickerComponent` : `startOfMonth/addMonths/buildCells/toIso`). Grille 7×6, cellule = pastilles colorées **par type** (maintenance, incident ; réservation S8) + compteur. **Mobile-first** : 1 mois, navigation mois fluide (`cubic-bezier(.16,1,.3,1)`).
  - **Clic jour** → volet (bottom-sheet mobile) listant les événements du jour (badge type/couleur, statut, véhicule, actions).
  - **Filtres** (barre compacte, réutilise le pattern reports) : **véhicule**, **groupe** (S1 : `selectedGroupId`/`groupOptions`), **type**, **statut**.
  - **Section « À venir / En retard »** (les PLANNED/OPEN triés par urgence) = les rappels visibles.
  - **Création** : bouton « + Événement » (`agenda_manage`) → modal (véhicule, type, catégorie, dates, odomètre pré-rempli, description).
- **Service web** `agenda.service.ts` (`/api/agenda/*`). **DTOs** `packages/shared/src/dto/agenda.dto.ts` (`VehicleEventDto`, `CreateVehicleEventDto`, `MaintenancePlanDto`, `EventType`/`EventStatus` unions) + export index.
- **Design system** : tokens existants, `.s-card`, `GroupBadge` (étendu pour les types), dropdowns reports, lucide. Couleurs par type (maintenance=vert/`--tracky`, incident=ambre/rouge, réservation=bleu réservé S8).

## 7. Front — Fiche véhicule (`vehicle-detail.component.ts`)
- **+1 onglet « Maintenance »** (après Geofences, avant Schedule ; gated `agenda_view`) : km estimé + dernier entretien + prochaines échéances (depuis `/agenda/events?vehicleId` + `/agenda/plans`) + bouton « Enregistrer un entretien » (`agenda_manage`) + gestion des plans.
- **« Signaler un incident »** : action (gated `agenda_view`) → modal simple (titre, sévérité, description, photo plus tard) → `POST /agenda/incidents` → remonte dans l'agenda (status OPEN). **Sans toucher** au reste de la fiche.

## 8. Fichiers touchés (prévision)
**Shared** : `permissions/permissions.ts` (+2 perms), `dto/agenda.dto.ts` (+ index).
**API** : `prisma/schema.prisma` (+2 modèles, +2 champs Vehicle, +1 AlertType) + migration ; `agenda/` (module, 2 services events/plans, 2 controllers, reminder cron, odometer service) + specs ; réutilise `vehicle-access`, `common/*scope*`, `notifications/*`.
**Web** : `features/agenda/` (agenda + calendar + modal), `core/services/agenda.service.ts`, `app.routes.ts` (+route), `layouts/dashboard-layout` (+nav), `features/vehicles/vehicle-detail.component.ts` (+onglet +action), réutilise `DateRangePicker` helpers / `GroupBadge`.

## 9. Plan de test
- **Scoping/IDOR (prioritaire)** : un user scopé groupe ne liste/édite que ses véhicules ; `vehicleId` hors périmètre → 403 (events, incidents, plans, odometer). Mock `VehicleAccessService`.
- **Permissions** : `agenda_view` requis pour signaler/voir ; `agenda_manage` pour gérer ; défauts par rôle (super/fleet-admin ON, autres OFF).
- **Récurrence** : `nextDue` correct (mois + km) ; matérialisation PLANNED idempotente ; DONE met à jour le plan.
- **Dérivation km** : `estimate` = baseline + SUM(trips depuis) ; mise à jour du baseline.
- **Incident → agenda** : POST incident → VehicleEvent OPEN visible ; transitions OPEN→IN_PROGRESS→DONE ; chaînage `linkedEventId`.
- **Rappel** : cron crée l'Alert MAINTENANCE_DUE dans le préavis, pas en double (anti-spam).
- Vérif : `pnpm -w typecheck` + jest api + build web.

## 10. Points d'extension S8 (rappel — documentés, NON codés)
- `VehicleEventType += RESERVATION` (déjà stub) ; créneaux via `endAt`+`allDay=false` ; champs réservation via `metadata`.
- **`VehicleEventService.findOverlaps(vehicleId, from, to)`** (stub documenté) = base du moteur de conflit/disponibilité S8.
- Calendrier type-agnostique + filtre type extensible → réservations s'affichent sans refonte.

---
**Phase 2 terminée.** Sur ton OK, j'implémente la Phase 3 dans l'ordre ci-dessus (socle perms → modèles/migration → backend générique + tests → maintenance/cron → front agenda → fiche véhicule), commits atomiques, branche prête pour relecture (je ne merge rien).
