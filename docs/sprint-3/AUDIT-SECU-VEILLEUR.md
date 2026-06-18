# Sprint 3 — Audit de sécurité du rôle « Veilleur de nuit » (NIGHT_WATCHMAN)

> Checkpoint sécu #1. Enforcement **serveur**, scoping **tenant strict**, **zéro escalade**.
> Périmètre veilleur = **voir ses véhicules (scopés) + couper/redémarrer le moteur (per-véhicule, scopé)**. Tout le reste = **403**.

## 1. Chaîne d'enforcement (5 portes — toutes en allowlist `SUPER_ADMIN`/`FLEET_ADMIN`)

Le point critique : **chaque** garde de privilège bypasse via une **allowlist explicite** des deux rôles admin. `NIGHT_WATCHMAN` n'y est jamais → il est **toujours traité comme un rôle scopé non privilégié**, sans risque d'escalade accidentelle par le nouveau rôle.

| # | Garde | Fichier:ligne | Comportement pour NIGHT_WATCHMAN |
|---|-------|---------------|----------------------------------|
| 1 | `RolesGuard` | `auth/guards/roles.guard.ts:17,22` | `@Roles` absent → autorise ; sinon rôle ∈ liste. NW n'est ajouté qu'aux GET véhicules + POST engine → **403 partout ailleurs**. |
| 2 | `PermissionsGuard` | `auth/guards/permissions.guard.ts:65` | `SUPER_ADMIN/FLEET_ADMIN` bypass ; NW passe par le resolver. |
| 3 | `PermissionsResolver.canOnVehicle` | `permissions/permissions-resolver.service.ts:76,128` | Aucune règle `UserVehicleAccess` ne couvre le véhicule → `null` → **`false`**. **Pas de fallback sur les perms globales** pour les actions per-véhicule. |
| 4 | `getAccessibleVehicleIds` | `vehicle-access/vehicle-access.service.ts:30` | Allowlist → `'ALL'` ; NW → scope `UserVehicleAccess` (groupe/véhicule, ou `[]`). |
| 5 | `resolveTenantScope` | `common/tenant-scope.ts:33` | `SUPER_ADMIN`→ALL ; sans `fleetId`→**DENY** ; sinon FLEET (fail-closed). |
| + | IDOR `vehicles.findOne` | `vehicles/vehicles.service.ts:227-254` | Triple couche tenant + accessibleVehicleIds → **404** hors-scope. |

## 2. Surface autorisée (allowlist — exactement 4 handlers)

| Endpoint | Garde | Scoping |
|----------|-------|---------|
| `GET /vehicles` | `@Roles(...NW)` + `@RequirePermissions('vehicles_view')` | liste filtrée par `accessibleVehicleIds` |
| `GET /vehicles/:id` | idem | IDOR `findOne` → 404 hors-scope |
| `GET /vehicles/snapshot` | `@Roles(...NW)` | filtré par `accessibleVehicleIds` |
| `POST /engine-control/trackers/:trackerId/commands` | `@Roles(...NW)` + `@RequireVehiclePermission('engine_control', trackerId)` | per-véhicule : `null`→refus hors-scope |

`GET /vehicles/stats`, `GET /engine-control/commands`, `GET /engine-control/commands/:id` **restent admin** → 403 veilleur (déni par défaut ; le veilleur lit l'état coupe via `engineCutState` du snapshot, pas via l'historique commandes).

## 3. Endpoints self-scoped accessibles (données PROPRES au user — pas une fuite de périmètre flotte)

Ces routes n'ont pas de `@Roles` (donc `RolesGuard` les laisse passer) mais ne renvoient/écrivent **que les données du user lui-même** ; elles sont nécessaires au fonctionnement de l'app (hydratation session, télémétrie). Aucune donnée d'autres users/flottes.

`GET /auth/me` · `GET|PATCH /users/me` · `GET /users/me/access` · `POST /activity/batch|error` · `GET|POST|DELETE /notifications/push/*` (propres) · `POST /realtime/incident` (propre session).

## 4. Audit des 33 controllers — verdict veilleur

**Tous 403 par `RolesGuard`** (NW ∉ leur `@Roles`), sauf l'allowlist §2 et le self-scoped §3 :

| Domaine | Controllers | `@Roles` typiques | Veilleur |
|---------|-------------|-------------------|----------|
| Véhicules (lecture) | vehicles GET | …VIEWER **+NW** | ✅ scopé |
| Engine (coupe) | engine POST | …VIEWER **+NW** | ✅ per-véhicule scopé |
| Engine (historique) | engine GET | FA,SA,FM | ⛔ 403 |
| Véhicules (écriture) | vehicles POST/PATCH/DELETE/group/driver/stats | FA,SA(,FM) | ⛔ 403 |
| Horaires | vehicle-schedules | FA,SA(,FM) | ⛔ 403 *(ouvert en S3·4 via toggle `schedules_manage`)* |
| Alertes | alerts, notifications/rules | …VIEWER / FA,SA,FM | ⛔ 403 |
| Rapports | reports | …VIEWER | ⛔ 403 |
| Conducteurs | drivers | …VIEWER | ⛔ 403 |
| Géofences | geofences | …VIEWER | ⛔ 403 |
| Groupes | vehicle-groups | FA,SA(,FM,VIEWER) | ⛔ 403 |
| Trajets | trips | …VIEWER | ⛔ 403 |
| Positions | positions | …VIEWER | ⛔ 403 |
| Trackers | trackers | …VIEWER / FA,SA | ⛔ 403 |
| SIM | sims | …VIEWER / SA | ⛔ 403 |
| Utilisateurs | users (CRUD/invitations/access) | FA,SA(,FM) | ⛔ 403 |
| Surveillance | surveillance | SA,FA,FM | ⛔ 403 |
| Flottes | fleets | SA,FA,FM | ⛔ 403 |
| Admin/obs | sms-admin, observability, system-metrics, activity, sampling, fix-mode, installations, tracker-commands, backup-health | SA (/FA) | ⛔ 403 |
| Public | auth login/refresh/logout, health, leads, sms/webhook (HMAC), internal (secret) | — | inchangé |

## 5. Tests de sécurité — `auth/night-watchman.security.spec.ts` (16/16 ✅)

| Bloc | Prouve |
|------|--------|
| **A** Défauts | `getDefaultPermissions('NIGHT_WATCHMAN')` = strictement `vehicles_view`+`engine_control` ; tout le reste (dont `schedules_manage`, `users_manage`, `alerts_view`…) = `false`. |
| **B** RolesGuard | Les **5 formes distinctes** de `@Roles` de l'API (`[FA,SA,FM,VIEWER]`, `[FA,SA,FM]`, `[FA,SA]`, `[SA,FA]`, `[SA]`) → **403** pour le veilleur. La liste in-périmètre (avec NW) → autorisé. |
| **C** Scoping per-véhicule | Véhicule **dans** le scope → coupe autorisée ; **hors** scope (`resolveForVehicle=null`) → **refus** malgré `engine_control=true` par défaut *(anti-fuite)* ; override `{engine_control:false}` → refus (spécifique gagne). |
| **D** Anti-escalade | Un granter `FLEET_MANAGER` (sans `engine_control`) **ne peut pas** créer un veilleur avec `engine_control` (`clampPermissions`→false) ; un `FLEET_ADMIN` le peut. |
| **E** Reflet réel | Reflète les `@Roles` **réellement posés** : NW présent **uniquement** sur vehicles lecture + engine POST ; **aucun** handler des controllers sensibles (alerts/reports/drivers/geofences/schedules/trips) ne liste NW. Échoue si un futur changement élargit le périmètre. |

## 6. Conclusion

- ✅ Veilleur **403 hors-périmètre** (RolesGuard, allowlist).
- ✅ **Zéro escalade** : per-véhicule sans fallback global + clamp anti-escalade.
- ✅ **Tenant strict** : `resolveTenantScope` fail-closed + IDOR `findOne` 404.
- ✅ Surface minimale : 4 handlers, scopés ; le reste nié par défaut.

Suite : **449 tests API** + spec sécu veilleur (16) + live-split (6) + typecheck + ng build, tous verts.

## 7. Durcissements post-code-review (revue finale, multi-agents)

La `/code-review` du diff S3 complet a **confirmé 2 vrais points** (corrigés) + **réfuté 1** :

1. **Fuite de positions via les events `fleet:*`** (CONFIRMÉ → corrigé). `ALERT_NEW` /
   `GEOFENCE_VIOLATION` / `TRIP_*` portent `lat/lng/vitesse` et étaient diffusés sur
   `fleet:<flotte>`, que le veilleur rejoignait → il recevait des positions ponctuelles de
   véhicules **hors de son groupe**. **Fix** : room dédiée **`ops:fleet:*`** qui ne porte QUE
   la confirmation moteur S2 + le statut tracker ; le veilleur rejoint `ops:*` et **plus du tout
   `fleet:*` ni `pos:*`** → **aucune position** (ni live, ni évènementielle). `emitEngineCommandUpdate`
   / `emitTrackerStatus` émettent aussi vers `ops`.
2. **Onglets du détail sur-exposés** (CONFIRMÉ → corrigé). L'onglet *Horaires* était gardé sur
   `engine_control` (que le veilleur a) → affiché mais **403** backend. **Fix** : *Horaires* suit
   `schedules_manage` (front=back) ; le veilleur est restreint aux onglets **Carte + Horaires(si
   toggle)**. Le bloquer/débloquer reste en en-tête.
3. **« Régression FLEET_MANAGER horaires »** (RÉFUTÉ). Un FM n'atteint un véhicule que s'il a une
   règle d'accès le couvrant → `resolveForVehicle` ≠ null → `schedules_manage` (défaut FM true)
   passe. Le changement **resserre** même FM (flotte → scope d'accès). Pas un bug.

Nettoyages : `AuthService.isWatchman()` partagé (remplace ~5 littéraux front) ; helper
`rejectSpeed()` (factorise les 5 chemins `REJECTED_SPEED`).

Self-scoped re-vérifiées (`activity/batch`, `activity/error`, `realtime/incident`) : écrivent
uniquement `userId: req.user.id` (JWT), DTO body sans userId → pas de spoofing ; lectures
cross-user `@Roles(SUPER_ADMIN)`. **Own-data-only confirmé.**
