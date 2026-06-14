# Sprint 1 — Fondation Groupes · ANALYSE (Phase 1)

> **Base** : `main` @ `827f8ec` · Worktree isolé `feat/sprint-1-fondation-groupes`.
> **Données** : prod **live** consultées en **lecture seule** (VPS `tracky-postgres`, DB `tracky_prod`) — pas de données factices.
> **Méthodo** : analyse avant code. Ce document répond aux pré-requis du brief, dresse l'inventaire des points d'affichage, et liste les risques.

---

## 0. TL;DR

- L'entité **Groupe existe déjà** : `VehicleGroup` (table `vehicle_groups`), **scopée tenant** via `fleetId`.
- La relation véhicule ↔ groupe est **many-to-many au schéma** (`VehicleGroupAssignment`), mais **de-facto mono-groupe en prod** : **0 véhicule sur 14** appartient à plus d'un groupe.
- **Décision tranchée** (validée) : on expose du **1 groupe / véhicule** côté UX. **Schéma M2M conservé → aucune migration.**
- Le backend **CRUD groupes + assignation/désassignation existe déjà et est correctement sécurisé** (tenant scoping fail-closed). → à **réutiliser**, pas à réécrire.
- Le **vrai périmètre** du sprint :
  1. **Exposer le groupe côté véhicule** : le DTO véhicule ne le porte pas aujourd'hui → l'ajouter, puis afficher un **badge** sur les surfaces clés.
  2. **Vue groupée navigable** : un mode **« groupé » sur `/vehicles`** (toggle), avec une **section « Sans groupe »** (critique : 10/14 véhicules).
  3. **Assignation depuis la page Détail** (absente ; endpoints back présents).
  4. **Retour rapide** : aujourd'hui le retour du détail est **hardcodé vers `/dashboard`**.

---

## 1. Réponses aux pré-requis d'analyse

| Pré-requis | Réponse |
|---|---|
| **L'entité « Groupe » existe-t-elle ?** | **Oui.** `model VehicleGroup` → table `vehicle_groups`. Champs : `id (uuid)`, `name (text)`, `fleetId (uuid)`, `createdAt`. **Minimal** : pas de `description`, `color`, `icon`, ni `updatedAt`. Contrainte `@@unique([fleetId, name])` (noms de groupe uniques par tenant). |
| **Cardinalité véhicule ↔ groupe** | **Many-to-many au schéma** : `model VehicleGroupAssignment` (PK composite `[vehicleId, groupId]`, table de jointure pure) ; `Vehicle.groups: VehicleGroupAssignment[]`, **aucune** colonne `groupId` sur `vehicles`. **MAIS en prod : 10 véhicules sans groupe, 4 avec exactement 1, 0 avec ≥2** → mono-groupe de fait. **Décision : 1 groupe/véhicule en UX, schéma M2M gardé.** |
| **Périmètre tenant** | **Scopé par fleet.** Le tenant = la **`Fleet`**. `VehicleGroup.fleetId` (NOT NULL) + `onDelete: Cascade`. Tout l'accès groupes passe déjà par `resolveTenantScope(req.user)` (fail-closed : un non-super sans `fleetId` → **DENY**) et un filtre `fleetId` dans le `where`. |
| **Existant à réutiliser** | Voir §2. Backend : contrôleur groupes complet + service véhicules + pattern d'accès (`VehicleAccessService`, `resolveTenantScope`, `PermissionsGuard`). Frontend : `VehicleGroupsService` (toutes les méthodes API), page `/groups`, liste véhicules + son toggle de vue, page détail, `RealtimeService` (carte). |
| **Endpoints déjà là ?** | **Oui pour les groupes** (liste, CRUD, assign/désassign). **Non pour « le groupe d'un véhicule »** : ni `GET /vehicles` ni `GET /vehicles/:id` ne renvoient le groupe ; il n'existe pas d'endpoint « définir le groupe d'un véhicule » côté ressource véhicule. → 1 ajout backend (DTO + 1 endpoint), 0 nouveau modèle. |

---

## 2. État de l'existant (détaillé)

### 2.1 Modèle de données (`apps/api/prisma/schema.prisma`)

```
Fleet (tenant) 1───* Vehicle
Fleet          1───* VehicleGroup           @@unique([fleetId, name])
Vehicle  *───* VehicleGroup  via  VehicleGroupAssignment  (PK [vehicleId, groupId])
VehicleGroup   1───* UserVehicleAccess      (permissions par groupe — VEHICLE > GROUP > ALL)
```

- `VehicleGroup` : `id, name, fleetId, createdAt`. Relations : `fleet`, `vehicles (assignments)`, `users (UserVehicleAccess)`.
- `UserVehicleAccess` : porte les permissions résolues par scope (`accessType` VEHICLE/GROUP/ALL, `groupId?`, `vehicleId?`, `permissions jsonb`). **Important pour la réutilisabilité** : le groupe est déjà le pivot du modèle de permissions → la vue groupée et le futur rôle « veilleur de nuit » (Sprint 2) s'appuieront dessus.

### 2.2 Backend (NestJS) — `apps/api/src`

| Élément | Fichier | Notes |
|---|---|---|
| **Groupes (CRUD + assign)** | `vehicle-groups/vehicle-groups.controller.ts` | `@Controller('vehicle-groups')`. `GET` (liste + `_count.vehicles`), `POST`, `PATCH :id` (rename), `DELETE :id`, `POST :id/vehicles` (assign), `DELETE :id/vehicles/:vehicleId` (désassign). Sécurité : `resolveTenantScope` (fail-closed), `findGroupInFleet` (404 cross-fleet, pas de leak), **défense en profondeur** (le véhicule doit être dans la même fleet que le groupe). `Roles` : lecture pour tous les rôles, écriture FLEET_ADMIN/SUPER_ADMIN. |
| **Véhicules** | `vehicles/vehicles.controller.ts` + `vehicles.service.ts` | `@Controller('vehicles')`. `GET` (liste, search, pagination cursor), `GET :id`, `GET stats`, `GET snapshot` (carte), CRUD, `PATCH :id/driver`. **Aucune** des réponses n'inclut le groupe (selects vérifiés : `tracker`, `currentDriver`, `schedule`). Sécurité : `buildRequestedBy` → `VehicleAccessService.getAccessibleVehicleIds`, `resolveTenantScope`, IDOR fix (filtre tenant dans le `where`, 404), `@RequirePermissions('vehicles_view'/...)`. |
| **Accès / permissions** | `vehicle-access/vehicle-access.service.ts`, `common/tenant-scope.ts` | Résout les véhicules accessibles d'un user (y compris via assignments de groupe). À **réutiliser tel quel** — ne pas réinventer le scoping. |

### 2.3 Frontend (Angular) — `apps/web/src/app`

| Élément | Fichier | Notes |
|---|---|---|
| **Service groupes** | `core/services/vehicle-groups.service.ts` | `list()`, `create()`, `rename()`, `remove()`, `addVehicle()`, `removeVehicle()`, `getUserAccess()`, `setUserAccess()`. Modèle `VehicleGroup { id, name, fleetId, createdAt, vehicles:[{vehicleId}], _count:{vehicles} }`. |
| **Gestion des groupes (UI)** | `features/vehicles/vehicle-groups-tab.component.ts` + `features/vehicle-groups/vehicle-groups.page.ts` | Route **`/groups`** (« Groupes de véhicules », guard `groups_view`). UI **orientée gestion** : créer/renommer/supprimer un groupe, ajouter/retirer des véhicules. **Ne montre pas** les véhicules sans groupe ; ce n'est pas une vue de navigation. |
| **Liste véhicules** | `features/vehicles/vehicles-list.component.ts` | `viewMode: signal<'cards'\|'table'>` persisté via `PreferencesService.prefs().vehiclesView`, `setViewMode()`. Template `view-switch` (2 boutons). Header contient déjà un lien conditionné `groups_view`. **Pas d'info groupe** sur les cartes/lignes. |
| **Détail véhicule** | `features/vehicles/vehicle-detail.component.ts` | Bouton retour **`routerLink="/dashboard"`** (l.55) ; `router.navigate(['/dashboard'])` en l.1691/1724. Onglets (live, historique, trips, surveillance…). **Pas d'info ni d'assignation de groupe.** |
| **Carte** | `features/map/map.component.ts` | Markers + popup (plaque, vitesse, ignition…), alimentés par `GET /vehicles/snapshot` (`VehicleSnapshotDto`) + `RealtimeService` (WS). **Pas de groupe** dans le snapshot. |
| **Rapports** | `features/reports/reports.component.ts` | Sélecteur de véhicule (plaque + marque/modèle) + lignes de trajets. Pas de groupe. |
| **DTO véhicule (front)** | `core/services/vehicles.service.ts` | `VehicleDetailDto` : `id, plate, type, brand, model, year, color, fleetId, tracker, currentDriver, createdAt, schedule`. **Pas de champ `group`.** |
| **État** | Signals + services (pas de store NgRx). `PreferencesService`, `PermissionsService`, `RealtimeService`. |

---

## 3. Données live (prod, lecture seule)

```
fleets         : 4        vehicles : 14
vehicle_groups : 4        assignments : 4

Véhicules par nb de groupes :   0 groupe → 10   |   1 groupe → 4   |   ≥2 groupes → 0
Groupes (tous dans 1 seule fleet) : CELESTE(1), BOREAL(1), LYRA(1), 425(1)
```

**Lectures pour le design** :
- La **section « Sans groupe » n'est pas un cas marginal** : c'est la majorité (10/14). Elle doit être traitée comme une section de premier rang, pas un repli.
- Le **mono-groupe** est confirmé par 100 % des données → la décision 1:1 ne perd aucune information existante.
- Volumes faibles → le **regroupement client-side** dans la vue groupée est largement suffisant (pas besoin d'endpoint dédié ni de pagination par groupe à ce stade).

---

## 4. Inventaire des points d'affichage d'un véhicule (objectif #4)

> Source : sweep exhaustif de `apps/web`. Priorisé pour cibler le badge groupe là où il a de la valeur, sans sur-ingénierie.

**Tier 1 — surfaces principales (badge groupe en scope)**
- `features/vehicles/vehicles-list.component.ts` — cartes **et** tableau (la surface n°1 « retrouver un véhicule »).
- `features/vehicles/vehicle-detail.component.ts` — en-tête du détail (+ contrôle d'assignation).
- **Vue groupée** (nouvelle, sur `/vehicles`) — l'en-tête de section **est** le groupe.
- `features/map/map.component.ts` — **popup** de marker (via `snapshot`).
- `features/reports/reports.component.ts` — sélecteur de véhicule (label groupe en option).

**Tier 2 — secondaire (optionnel, si peu coûteux)**
- `features/alerts/alerts.component.ts` — lignes d'alerte (plaque déjà affichée ; groupe = bonus).
- `features/vehicles/vehicle-dialog/...` — formulaire create/edit (assignation au formulaire = bonus ; l'objectif vise la page Détail).

**Tier 3 — hors-scope (admin/edge, faible valeur, coût élevé)**
- `installations/*`, `sims/*`, `surveillance/*`, `geofences/*`, `drivers-list` (compteurs), `dashboard` (KPI agrégés / mini-map). Justification dans le PLAN §H.

---

## 5. Risques & points d'attention

1. **Cohérence M2M ↔ mono-groupe.** L'onglet d'admin `/groups` reste capable d'assigner un véhicule à plusieurs groupes (add-only). Le DTO véhicule doit donc rester **robuste si la donnée legacy contient >1 groupe** (on affiche **le premier**, et l'assignation depuis le détail **normalise vers un seul**). Documenté dans le PLAN.
2. **Chemin chaud `snapshot` (carte).** `GET /vehicles/snapshot` est caché 15 s, `take: 2000`, et `VehicleSnapshotDto` est partagé (`@vizyo/tracky-shared`). Ajouter le groupe = +1 jointure + champ partagé → surveiller le payload (faible risque aux volumes actuels, à valider au build).
3. **Ne rien casser.** Les selects véhicules sont volontairement réduits (perf). L'ajout du groupe doit être **additif** (champ optionnel) pour ne pas régresser listes/carte/dashboard.
4. **Scoping tenant = critère d'acceptation.** Toute lecture/écriture de groupe doit passer par les patterns existants (`resolveTenantScope`, `findGroupInFleet`, vérif fleet du véhicule). Tests IDOR obligatoires (cf. PLAN §F).
5. **Retour rapide.** Le retour hardcodé `/dashboard` doit devenir **contextuel** sans casser les entrées directes (deep-link sur `/vehicles/:id`) → fallback robuste requis.
6. **Persistance du toggle.** `PreferencesService.vehiclesView` est typé `'cards'|'table'` → étendre l'union à `'grouped'` proprement (migration de préférence tolérante).

---

## 6. Décisions de modélisation (à acter en revue)

- **Cardinalité = 1 groupe / véhicule (UX).** Schéma `VehicleGroupAssignment` (M2M) **conservé**, **aucune migration**. Rationale : colle au métier (« un groupe »), à 100 % des données prod, zéro risque migratoire, et garde la porte ouverte (le schéma reste M2M pour un éventuel besoin futur).
- **Vue groupée = mode `grouped` sur `/vehicles`** (pas une nouvelle route, pas l'extension de `/groups`). Réutilise les cartes véhicules existantes, mobile-first, reste le point d'entrée naturel et **réutilisable** pour le rôle veilleur de nuit (Sprint 2). `/groups` reste la page d'**administration** des groupes.
- **Pas de nouveau modèle, pas de champ ajouté au schéma.** Tout l'effort est : exposer (DTO) + afficher (front) + 1 endpoint d'assignation côté ressource véhicule + 1 vue.
