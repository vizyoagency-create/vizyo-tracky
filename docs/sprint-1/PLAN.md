# Sprint 1 — Fondation Groupes · PLAN (Phase 2)

> Suite de `ANALYSE.md`. Décisions actées : **1 groupe/véhicule** (schéma M2M conservé, **aucune migration**) · **vue groupée = toggle sur `/vehicles`**.
> Principe directeur : **réutiliser** l'existant (CRUD groupes, scoping tenant, toggle de vue, service groupes front) ; n'ajouter que le strict nécessaire.

---

## A. Modèle de données

- **Aucune migration Prisma.** On garde `VehicleGroup` + `VehicleGroupAssignment` (M2M) tels quels.
- Le « 1 groupe » est une **règle applicative**, pas un changement de schéma : l'endpoint d'assignation par véhicule normalise vers une seule assignation.
- Robustesse legacy : si un véhicule a >1 assignation (possible via l'admin `/groups`), le **groupe affiché = le premier par `name` asc**.

---

## B. Backend (`apps/api/src`)

### B1. Exposer le groupe dans les réponses véhicule
- **`vehicles.service.ts`** : ajouter un `select` groupe **additif** dans `findAll`, `findOne` (et `snapshot` pour la carte) :
  ```ts
  groups: { select: { group: { select: { id: true, name: true } } }, take: 1, orderBy: { group: { name: 'asc' } } }
  ```
  puis **aplatir** vers `group: { id, name } | null` dans le mapping de sortie (ne pas exposer la forme jointure au front).
- **Type de retour** : introduire un helper de mapping `toVehicleResponse()` (ou étendre les `*Dto`) pour ajouter `group`. Garder les autres champs identiques (additif).

### B2. Endpoint « définir le groupe d'un véhicule » (assignation depuis le Détail)
- **`vehicles.controller.ts`** : `PUT /vehicles/:id/group` body `{ groupId: string | null }`.
  - Réutilise `buildRequestedBy` + `vehicles.findOne(id, requestedBy)` (→ scoping tenant + IDOR + accès granulaire **gratuits**).
  - `groupId` non null : vérifier que le groupe est dans **la même fleet que le véhicule** (même défense que `vehicle-groups.controller.addVehicle`).
  - **Transaction** : `deleteMany({ vehicleId })` puis `create({ vehicleId, groupId })` si `groupId` ≠ null (sinon on retire juste → « sans groupe »).
  - `@RequirePermissions('groups_manage')` (cohérent avec l'admin groupes), `Roles` FLEET_ADMIN/FLEET_MANAGER/SUPER_ADMIN.
  - Retourne le véhicule mis à jour (avec `group`) pour rafraîchir l'UI immédiatement.
- **Pourquoi un endpoint dédié** plutôt que réutiliser `POST/DELETE /vehicle-groups/:id/vehicles` : sémantique **replace atomique** (single-group), un seul aller-retour, et l'autorité reste la ressource véhicule (scoping déjà éprouvé).

### B3. Shared DTO
- **`libs/shared` (`@vizyo/tracky-shared`)** : ajouter `group?: { id: string; name: string } | null` à `VehicleSnapshotDto` (carte). Champ **optionnel** → pas de rupture.

---

## C. Frontend (`apps/web/src/app`)

### C1. Modèles / service
- **`core/services/vehicles.service.ts`** : ajouter `group?: { id: string; name: string } | null` à `VehicleDetailDto` ; ajouter `setGroup(id, groupId|null)` → `PUT /api/vehicles/:id/group`.
- Réutiliser **`VehicleGroupsService.list()`** pour peupler le sélecteur d'assignation (déjà tenant-scopé côté back).

### C2. Vue groupée (objectif #1) — toggle sur `/vehicles`
- **`features/vehicles/vehicles-list.component.ts`** :
  - Étendre `viewMode` → `'cards' | 'table' | 'grouped'` (+ 3ᵉ bouton dans `view-switch`, icône groupes).
  - Branche `@if (viewMode() === 'grouped')` : **regroupement client-side** des véhicules déjà chargés par `group?.id`, tri des groupes par `name`, **section « Sans groupe » en premier** (10/14), compteur par section, sections **pliables/dépliables** (signal `Set<groupId>` d'état d'expansion).
  - Réutiliser la **carte véhicule** existante pour le rendu des items (pas de duplication visuelle).
  - Mobile-first : sections en pleine largeur, en-têtes sticky légères.
- **`core/services/preferences.service.ts`** : étendre le type `vehiclesView` à `'grouped'` (lecture tolérante des valeurs inconnues → fallback `'cards'`).

### C3. Badge groupe (objectif #4) — composant partagé réutilisable
- **Nouveau** `shared/ui/group-badge/group-badge.component.ts` : `@Input() group: { name } | null`. Rendu discret (puce/label), état « Sans groupe » géré. Réutilise les tokens du design system (variables `--tracky*`, `--bg-*`).
- Poser le badge sur **Tier 1** : cartes + lignes de la liste, en-tête du détail, popup carte, label du sélecteur rapports.

### C4. Assignation depuis le Détail (objectif #3)
- **`features/vehicles/vehicle-detail.component.ts`** : bloc « Groupe » dans l'en-tête :
  - Affiche le groupe courant (badge) ou « Sans groupe ».
  - Bouton « Changer » → sélecteur (liste `VehicleGroupsService.list()`, **recherche** si beaucoup de groupes, option « Aucun (retirer du groupe) »).
  - À la validation : `setGroup()` → mise à jour **optimiste** + toast de confirmation ; rollback si erreur.
  - Visible si `groups_manage` (sinon badge en lecture seule).

### C5. Navigation & retour rapide (objectif #2)
- À la navigation liste/vue groupée → détail : passer le **contexte d'origine** via `state`/queryParams (ex. `?from=grouped&group=<id>`), et mémoriser la **position de scroll** + les sections dépliées (signal au niveau composant liste, ou `PreferencesService`).
- **`vehicle-detail.component.ts`** : remplacer le retour hardcodé `/dashboard` (l.55, 1691, 1724) par un retour **contextuel** :
  - si `from=grouped` → retour `/vehicles` en mode groupé, groupe d'origine déplié, scroll restauré ;
  - **fallback robuste** `/vehicles` (puis `/dashboard`) pour les deep-links directs.

### C6. Carte & rapports
- **`features/map/map.component.ts`** : afficher `group?.name` dans le **popup** (depuis `snapshot`).
- **`features/reports/reports.component.ts`** : ajouter le nom du groupe au label d'option du sélecteur (faible coût).

---

## D. Routing & logique de retour rapide (résumé)

| Depuis | Vers | Retour attendu |
|---|---|---|
| `/vehicles` (grouped) → carte/clic | `/vehicles/:id?from=grouped&group=<id>` | bouton retour → `/vehicles` (grouped, groupe déplié, scroll restauré) |
| `/vehicles` (cards/table) | `/vehicles/:id?from=list` | retour → `/vehicles` (vue précédente) |
| deep-link direct `/vehicles/:id` | — | retour → `/vehicles` (fallback), jamais d'écran cassé |

---

## E. Fichiers créés / modifiés

**Backend**
- ✏️ `apps/api/src/vehicles/vehicles.service.ts` — select+mapping `group` (findAll/findOne/snapshot).
- ✏️ `apps/api/src/vehicles/vehicles.controller.ts` — `PUT /vehicles/:id/group`.
- ➕ `apps/api/src/vehicles/dto/set-vehicle-group.dto.ts` — `{ groupId: string | null }` (validation class-validator).
- ✏️ `libs/shared/.../vehicle-snapshot.dto.ts` (`@vizyo/tracky-shared`) — champ `group?`.

**Frontend**
- ✏️ `apps/web/src/app/core/services/vehicles.service.ts` — `group` + `setGroup()`.
- ✏️ `apps/web/src/app/core/services/preferences.service.ts` — `vehiclesView` accepte `'grouped'`.
- ➕ `apps/web/src/app/shared/ui/group-badge/group-badge.component.ts` — badge réutilisable.
- ✏️ `apps/web/src/app/features/vehicles/vehicles-list.component.ts` — mode `grouped` + section « Sans groupe » + badges.
- ✏️ `apps/web/src/app/features/vehicles/vehicle-detail.component.ts` — bloc groupe + assignation + retour contextuel.
- ✏️ `apps/web/src/app/features/map/map.component.ts` — groupe dans le popup.
- ✏️ `apps/web/src/app/features/reports/reports.component.ts` — groupe dans le sélecteur.

> Les chemins exacts `libs/shared` seront confirmés à l'implémentation (localisation de `VehicleSnapshotDto`).

---

## F. Stratégie de test

**Backend (Jest)**
- `PUT /vehicles/:id/group` :
  - assigne / change / retire (`groupId: null`) — vérifie le **replace** (une seule assignation après).
  - **IDOR** : groupe d'une **autre fleet** → rejet (même fleet requise) ; véhicule d'une autre fleet → 404 (via `findOne`).
  - non-super sans `fleetId` → DENY ; rôle insuffisant → 403.
- `findAll`/`findOne` renvoient bien `group` (et `null` si sans groupe) ; cas legacy >1 assignation → renvoie le premier.

**Frontend**
- Liste : regroupement client-side correct, section « Sans groupe » présente et non masquée, compteurs justes, toggle persiste.
- Détail : assignation optimiste + rollback sur erreur ; retour contextuel (grouped/list/deep-link).
- Badge : rendu « Sans groupe » vs nom.

**Vérification** (cf. mémoire projet) : `pnpm -C <root> --filter @vizyo/tracky-{api,shared} typecheck` + `test` ; web → `ng build` (pas de typecheck web). Pas d'eslint dans le repo.

---

## G. Découpage en commits atomiques

1. `docs(sprint-1): analyse + plan fondation groupes`
2. `feat(api): expose le groupe (single) dans les DTO vehicule`
3. `feat(api): PUT /vehicles/:id/group (assignation single, tenant-scoped) + tests`
4. `feat(shared): champ group optionnel sur VehicleSnapshotDto`
5. `feat(web): badge groupe reutilisable + pose sur liste/detail/carte/rapports`
6. `feat(web): vue groupee (toggle /vehicles) + section « Sans groupe »`
7. `feat(web): assignation de groupe depuis la page Detail`
8. `feat(web): retour rapide contextuel groupe→detail (scroll + section)`
9. `test(web): vue groupee + assignation + retour contextuel`

---

## H. Hors-scope explicite (assumé)

- **Pas de migration** ni de nouveaux champs `VehicleGroup` (description, couleur, icône) — non demandés par le sprint.
- **Badge groupe sur les surfaces Tier 3** (installations, SIM, surveillance, geofences, dashboard KPI) : exclu (faible valeur, coût élevé, risque de bruit visuel). Réintégrable plus tard si besoin.
- **Rôle veilleur de nuit / filtres rapports par groupe / réservation** : Sprint 2+. La vue groupée est conçue **réutilisable** pour les accueillir, sans les implémenter ici.
- **Multi-groupes (M2M en UX)** : écarté par décision (cf. ANALYSE §6). Le schéma reste M2M si l'on devait y revenir.
