# Sprint 3 — Rôle « Veilleur de nuit » · ANALYSE

> Phase 1 (analyse AVANT code). Cartographie du modèle de rôles/permissions **réel**, points d'enforcement, réutilisation S1/S2, garde-fou à étendre, risques.
> **Base de branche** : `feat/sprint-3-veilleur-nuit` est créée **sur la tête S2** (pour référencer le code S2 réutilisé). ⚠️ **Avant implémentation/merge, une fois S2 mergé dans `main`, la branche sera REBASÉE sur `main`** (qui contiendra alors S2). Conformément au brief, l'ANALYSE/PLAN se fait « sur la base S2 ».

## 0. Conclusion d'entrée (TL;DR)

**Le système de permissions existant couvre déjà ~90 % des besoins de S3.** Il est **hybride (rôle + permissions fines + scope)** et conçu pour ça. On **ajoute un rôle**, **une clé de permission** (`schedules_manage`), et on **câble l'enforcement** sur les bons endpoints. **Aucune nouvelle table** n'est nécessaire (le scope par groupe existe déjà via `UserVehicleAccess`). Le risque principal n'est pas la construction mais l'**audit d'exhaustivité de l'enforcement serveur** (qu'aucun endpoint ne fuite au veilleur).

## 1. Modèle de rôles & permissions (réel)

### 1.1 Rôles — `apps/api/prisma/schema.prisma`
```prisma
enum UserRole { SUPER_ADMIN  FLEET_ADMIN  FLEET_MANAGER  VIEWER }
model User {
  role        UserRole @default(VIEWER)
  permissions Json?     // overrides per-user (UserPermissions partiel)
  fleetId     String?   // tenant
  vehicleAccess UserVehicleAccess[]  // scope (ALL/GROUP/VEHICLE)
  preferences Json?     // V1.12 — UI (uiMode), extensible
}
```
→ **On ajoute `NIGHT_WATCHMAN`** à l'enum (valeurs enum en anglais, libellé FR « Veilleur de nuit » côté UI). Migration Prisma additive (extension d'enum Postgres).

### 1.2 Catalogue de permissions — `packages/shared/src/permissions/permissions.ts`
`UserPermissions` = ~19 booléens : `vehicles_view`, `vehicles_create/edit/delete`, **`engine_control`**, `groups_view/manage`, `geofences_*`, `alerts_*`, `reports_view`, `users_*`, `drivers_*`, `sims_*`. **Pas de `schedules_manage`** aujourd'hui (les horaires sont role-gated, cf §6).
- `getDefaultPermissions(role)` renvoie les défauts par rôle. ADMIN/SUPER_ADMIN = tout `true` (et **bypass** total des guards) ; VIEWER/FLEET_MANAGER : `engine_control:false` par défaut.
- → **Défauts `NIGHT_WATCHMAN`** : `vehicles_view:true`, `engine_control:true`, **`schedules_manage:false`** (toggle OFF par défaut), **tout le reste `false`**.

### 1.3 Scope per-utilisateur — `UserVehicleAccess` (déjà multi-groupe !)
```prisma
model UserVehicleAccess { userId; accessType AccessType /* ALL|GROUP|VEHICLE */; groupId?; vehicleId?; permissions Json? }
```
- `accessibleVehicleIds` est calculé dans `apps/api/src/vehicle-access/vehicle-access.service.ts` (`getAccessibleVehicleIds`) : ADMIN→`'ALL'` ; sinon union des règles, **les `GROUP` étant étendus en véhicules** via `VehicleGroupAssignment`. Mémoïsé par requête.
- **Constat clé** : **rattacher un veilleur à 1..N groupes ou à toute la flotte est DÉJÀ possible** sans nouvelle table — une (ou plusieurs) ligne(s) `UserVehicleAccess` (`GROUP`+groupId, ou `ALL`). C'est la réponse mécanique à la **décision #1**.

### 1.4 Résolution per-véhicule — `apps/api/src/permissions/permissions-resolver.service.ts`
`resolveForVehicle/canOnVehicle` : ADMIN bypass ; sinon **spécificité `VEHICLE > GROUP > ALL`**, fallback `UserVehicleAccess.permissions` → `User.permissions` → défauts de rôle. C'est ce qui rend `engine_control` per-véhicule **réel côté serveur**.

## 2. Points d'enforcement SERVEUR (le vrai verrou)

Chaîne de guards (ex. `engine-control.controller.ts`) : `@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)`.
- **`RolesGuard`** (`auth/guards/roles.guard.ts`) lit `@Roles(...)` → rejette si `req.user.role` absent de la liste.
- **`PermissionsGuard`** (`auth/guards/permissions.guard.ts`) lit `@RequirePermissions(key)` (global) et `@RequireVehiclePermission(key,{paramName})` (per-véhicule) → `403` si refusé. ADMIN/FLEET_ADMIN bypass.
- **`resolveTenantScope`** (`common/tenant-scope.ts`) : `ALL` (SUPER), `FLEET` (fleetId), **`DENY` fail-closed** si non-SUPER sans fleetId.
- **Anti-escalade** : `clampPermissions()` (invitations/users) — `out[key] = wanted && granterPerms[key]` : on ne peut jamais accorder plus que ce qu'on a.

**Endpoint coupe-circuit** — `engine-control.controller.ts` :
```ts
@Roles(FLEET_ADMIN, SUPER_ADMIN, FLEET_MANAGER, VIEWER)
@RequireVehiclePermission('engine_control', { paramName: 'trackerId' })
requestCommand(...)
```
→ **Il FAUT ajouter `NIGHT_WATCHMAN`** à ce `@Roles` (sinon `RolesGuard` le rejette). La permission per-véhicule + le scope + l'IDOR du service (`vehicle.fleetId` intégré au `where`, cf S2) font le reste.

**Principe d'enforcement du veilleur (élégant)** : le rôle EST le verrou. En **n'ajoutant `NIGHT_WATCHMAN` qu'aux endpoints Véhicules (lecture) + Engine-control (+ Horaires si toggle)**, `RolesGuard` bloque le veilleur **partout ailleurs** par défaut. Les endpoints `@RequirePermissions(...)` le bloquent aussi (permissions `false`). 

## 3. Front : guards, masquage d'onglets, redirection login

- **Guards front existants** (à réutiliser) — `apps/web/src/app/core/guards/` : `authGuard`, `permissionGuard('vehicles_view')`, `roleGuard(...roles)`. Déjà appliqués route par route dans `app.routes.ts` (ex. `/alerts`→`permissionGuard('alerts_view')`, `/reports`→`reports_view`…).
- **`PermissionsService` front** (`core/services/permissions.service.ts`) : `can(perm, vehicleId?)`, ADMIN bypass, hydraté depuis **`GET /api/users/me/access`** (les `AccessEntry`). Source de vérité = backend.
- **Nav/onglets** : `layouts/dashboard-layout.component.ts` → `navItems` (computed) **conditionné par `perms.can(...)`**. Un onglet sans permission n'est pas rendu.
- **Redirection login** : `features/auth/login.component.ts` (`preferences.uiMode==='baanool' ? '/map' : '/dashboard'`). → on ajoute une **branche rôle** : veilleur → vue groupée.
- **Vue groupée S1** : route `/vehicles`, composant `vehicles-list.component.ts`, mode `'grouped'` (persisté en préférence `vehiclesView`). Pour deep-linker un veilleur : lire un **queryParam `viewMode`** à l'init **ou** poser la préférence. (S1 réutilisée telle quelle.)

> ⚠️ **Le front est cosmétique.** Masquer un onglet ≠ sécuriser. Le **blocage réel** est serveur (guards). Donc S3 = masquage UI **+** route guards front (anti-URL directe) **+** enforcement serveur (le seul qui compte).

## 4. Garde-fou vitesse S2 → « 0 km depuis X min » (extension, pas duplication)

`engine-control.service.ts > requestCommand`, bloc `action === CUT` : récupère `lastPosition` (`prisma.position.findFirst orderBy timestamp desc`) puis enchaîne les refus en **`REJECTED_SPEED`** : pas de position / position stale en mouvement (`STALE_THRESHOLD_MOVING_MS=60s`, sauf `isAtRest = speedKmh <= REST_SPEED_KMH(5)`) / fix invalide / `speedKmh > MAX_SPEED_FOR_CUT(20)`.
- **Extension** : après les checks existants, quand `isAtRest`, ajouter **« arrêté depuis ≥ X min »** : 2ᵉ requête `position.findFirst({ where:{ trackerId, speedKmh:{ gt: seuilMouvement } }, orderBy:{timestamp:desc} })` → `stoppedSince = now - lastMovement.timestamp`. Si `< X min` → **refus `REJECTED_SPEED`** avec message dédié (« pas encore arrêté assez longtemps »). **On réutilise l'état existant `REJECTED_SPEED`** (le brief : « raffiner l'existant », pas un 2ᵉ garde-fou). Table `positions` indexée `[trackerId, timestamp desc]` → 2 requêtes O(log n).
- **Tranché (voir PLAN §0)** : **rôle veilleur uniquement** (admins gardent ≤ 20 km/h, antivol préservé), défaut **2 min**, configurable via env `ENGINE_CUT_MIN_STOPPED_S` (config par-flotte = itération ultérieure).

## 5. Mode horaire + désactivation auto (à préserver)

`engine-control.service.ts`, sur `source==='MANUAL'` : si `disableSchedule===true` → `vehicleSchedule.updateMany({enabled:true} → {enabled:false, lastEvaluatedState:null, lastEvaluatedAt:null})` ; sinon **override temporaire 1 h** (`overrideUntil = now+1h`). Le cron (`schedule-cron.service.ts`) **respecte `overrideUntil`**. Le param vient du contrôleur (`dto.disableSchedule`). → **Comportement à NE PAS casser** : les coupures veilleur étant `MANUAL`, la neutralisation s'applique déjà. Réactivation **manuelle** ensuite (inchangé).

## 6. Toggle « gérer les horaires » par utilisateur

Aujourd'hui les horaires (`vehicle-schedules.controller.ts`) sont **role-gated seulement** (`@Roles(FLEET_ADMIN, SUPER_ADMIN, FLEET_MANAGER)` en lecture ; `@Roles(FLEET_ADMIN, SUPER_ADMIN)` en écriture) — **ni permission, ni scope**.
- **Reco (framework-native)** : ajouter une **clé `schedules_manage`** à `UserPermissions`, l'**enforcer** sur les endpoints horaires via `@RequirePermissions('schedules_manage')` (+ scope véhicule), et l'inclure dans `@Roles(... NIGHT_WATCHMAN)`. Le fleet/super admin l'active/désactive **par veilleur** via l'UI/endpoint de permissions existant. Avantages : **server-enforced**, **clampable** (anti-escalade), **scope-aware**. (Alternatives `User.preferences`/colonne booléenne **rejetées** : non enforced par les guards, pas scope-aware.)
- **Décision #3** : **OFF par défaut** à la création d'un veilleur (moindre privilège) — reco.

## 7. Réutilisation S1 / S2 (ne rien dupliquer)

| Besoin S3 | Réutilise | Où |
|---|---|---|
| Entrée vue groupée | **S1** vue `grouped` | `/vehicles` (`vehicles-list.component.ts`) |
| Start/stop + confirmation + tri-état + verrou 409 | **S2** pipeline commande | `engine-control` (back) + `engine-control-button` / carte (front) |
| Garde-fou vitesse → 0 km/X min | **S2** `REJECTED_SPEED` | `engine-control.service.ts` (raffinement) |
| Désactivation auto horaire | **existant** | `engine-control.service.ts` + `schedule-cron.service.ts` |
| Scope (1..N groupes / flotte) | **existant** | `UserVehicleAccess` |

## 8. Risques & points de sécurité (pour la relecture)

1. **Exhaustivité de l'enforcement serveur (risque #1)** : auditer **tous** les endpoints non-Véhicules pour garantir qu'ils sont soit `@Roles`-gated (sans `NIGHT_WATCHMAN`), soit `@RequirePermissions`-gated (permission que le veilleur n'a pas). **Un endpoint seulement sous `JwtAuthGuard` fuiterait.** Test : un token veilleur sur `/api/alerts`, `/api/reports`, `/api/users`, `/api/drivers`, `/api/geofences`, `/api/sims`, `/api/vehicle-schedules` (si toggle OFF) → **403** attendu.
2. **Escalade de privilège** : `clampPermissions()` empêche un admin d'accorder `engine_control`/`schedules_manage` qu'il n'a pas ; vérifier que la création/édition d'un veilleur passe bien par ce clamp.
3. **Contournement par URL directe (front)** : masquer l'onglet ne suffit pas → **route guard front** (`roleGuard`/`permissionGuard`) sur les routes interdites **+** enforcement serveur (point 1).
4. **Scoping tenant strict** : `resolveTenantScope` fail-closed + IDOR S2 (`vehicle.fleetId` au `where`) déjà en place ; ne pas régresser. Un veilleur ne voit/commande que `accessibleVehicleIds` (scope) **et** sa flotte.
5. **0 km/X min** : enforcement **serveur** (précondition de commande), pas juste UI ; refus explicite (`REJECTED_SPEED`, message clair), jamais un échec générique.
6. **UX « non vérifiable »** : pour le veilleur (coupures à l'arrêt = quasi-100 %), c'est l'**état NORMAL** (S2) — libellé rassurant, jamais rouge d'erreur.

## 9. Réponses aux pré-requis d'analyse du brief
- *Modèle de rôles/permissions* : hybride rôle + `UserPermissions` (JSON) + scope `UserVehicleAccess` ; enforce via `RolesGuard`+`PermissionsGuard`+resolver ; tenant via `resolveTenantScope`. **Ajout propre = nouveau rôle + 1 clé perm, sans toucher aux rôles existants.**
- *Flags per-utilisateur* : `User.permissions` (global) + `UserVehicleAccess.permissions` (per-scope). Le toggle horaires = nouvelle clé `schedules_manage`.
- *Masquage/route guarding* : `navItems` (perms) + guards front (`app.routes.ts`) ; le **vrai** blocage = guards serveur.
- *Redirection login par rôle* : `login.component.ts` (déjà role/préférence-aware).
- *Garde-fou vitesse* : `REJECTED_SPEED` dans `engine-control.service.ts`, étendu via une 2ᵉ requête `positions` (dernier mouvement).
- *Mode horaire* : neutralisation auto sur `MANUAL` (préserver).
- *Scope du veilleur* : techniquement 1..N groupes **ou** flotte via `UserVehicleAccess` → **décision #1**.

---
**Suite** : `PLAN.md` (après validation des 3 décisions ci-dessous).
