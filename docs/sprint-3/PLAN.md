# Sprint 3 — Rôle « Veilleur de nuit » · PLAN

> Phase 2. S'appuie sur `ANALYSE.md`. **Rien n'est implémenté** tant que (a) ce plan est validé et (b) **S2 est mergé**.
> **Base/branche** : `feat/sprint-3-veilleur-nuit` créée sur la **tête S2**. ⚠️ **Avant implémentation, une fois S2 mergé dans `main`, REBASE sur `main`** (qui contiendra S2). Si `main` bouge, on rejoue le rebase (comme S2).

## 0. Décisions actées (validées client)
1. **Scope veilleur** : **multi-groupes flexible** — 1..N groupes **ou** flotte entière, choisi par l'admin à la création, via `UserVehicleAccess` (`GROUP`/`ALL`). Aucune nouvelle table.
2. **Délai 0 km** : **défaut 2 min**, configurable via **env plateforme** `ENGINE_CUT_MIN_STOPPED_S` (défaut `120`). Config par-flotte = itération ultérieure (hors scope).
3. **Portée règle 0 km** : **rôle veilleur UNIQUEMENT** (revue client). Les admins/FLEET_MANAGER conservent la coupure S2 (≤ 20 km/h) → **antivol préservé** (couper un véhicule volé en mouvement lent reste possible pour un admin). La règle 0 km/2 min est une précondition **conditionnée à `requestedBy.role === UserRole.NIGHT_WATCHMAN`**.
4. **Toggle « gérer horaires »** : **OFF par défaut** (moindre privilège).

> ### ✅ Décision #3 — résolue (revue client) : règle scopée veilleur
> La règle « 0 km depuis X min » ne s'applique **qu'au rôle veilleur**. **Aucune régression** du chemin de coupe S2 pour les admins/managers (≤ 20 km/h, antivol intact). Implémentation : la nouvelle précondition est gardée par `if (requestedBy.role === UserRole.NIGHT_WATCHMAN) { … }` dans le bloc CUT → **les tests S2 existants (acteur `fleetAdmin`) ne sont pas impactés** ; on ajoute des tests dédiés au veilleur.

## 1. Rôle & permissions (modèle)

### 1.1 Nouveau rôle
- `apps/api/prisma/schema.prisma` : `enum UserRole { … NIGHT_WATCHMAN }` (valeur enum **anglaise**, libellé UI FR « Veilleur de nuit »).
- **Migration** : additive (extension d'enum Postgres). Hand-authored ou `prisma migrate dev`. Backward-compatible (`migrate deploy` au boot, cf S2).

### 1.2 Nouvelle clé de permission `schedules_manage`
- `packages/shared/src/permissions/permissions.ts` : ajouter `schedules_manage: boolean` à `UserPermissions` + `PERMISSION_LABELS` (groupe « Horaires »).
- **Pas de migration** : `User.permissions`/`UserVehicleAccess.permissions` sont des colonnes **JSON** ; on n'ajoute qu'une clé à l'interface + aux défauts.

### 1.3 Défauts par rôle (`getDefaultPermissions`)
- `NIGHT_WATCHMAN` = `{ vehicles_view:true, engine_control:true, schedules_manage:false, /* tout le reste:false */ }`.
- Ajouter `schedules_manage` aux autres rôles : ADMIN/SUPER=`true` (bypass de toute façon), FLEET_MANAGER=`true` (conserve le comportement actuel role-gated), VIEWER=`false`.

## 2. Enforcement SERVEUR (le vrai verrou) — par objectif

### Obj 1 — Rôle + matrice, enforced serveur
- `engine-control.controller.ts` : `@Roles(... , NIGHT_WATCHMAN)` sur `requestCommand` (sinon `RolesGuard` rejette). La permission per-véhicule `@RequireVehiclePermission('engine_control')` + le scope + l'IDOR S2 restent en place.
- Endpoints **Véhicules** nécessaires au veilleur (liste/snapshot/détail) : vérifier/ajouter `NIGHT_WATCHMAN` à leurs `@Roles` (ou s'assurer qu'ils sont `@RequirePermissions('vehicles_view')`, que le veilleur possède). Cibles : `vehicles.controller` (`GET /vehicles`, `GET /vehicles/snapshot`, `GET /vehicles/:id`), endpoints lus par le détail (position courante, commandes moteur récentes `engine-control GET`).

### Obj 2 — Masquage onglets + anti-URL (volet serveur)
- **Audit d'exhaustivité (tâche sécurité #1)** : lister tous les contrôleurs et garantir que chaque endpoint **non-Véhicules/non-engine** est soit `@Roles`-gated **sans** `NIGHT_WATCHMAN`, soit `@RequirePermissions(key)` avec `key` que le veilleur n'a pas. **Aucun endpoint sous `JwtAuthGuard` seul.** Cibles de test 403 : `alerts`, `reports`, `users`, `drivers`, `geofences`, `sims`, `vehicle-schedules` (si toggle OFF), `installations`, `trips`.

### Obj 2 bis — Live WS coupé SERVEUR pour le veilleur
- Room split positions : le veilleur ne rejoint pas `pos:fleet:X` → **aucune position live sur son socket** (il garde `fleet:X` pour la confirmation moteur S2 + alertes). Détail dans l'encadré « sans live » du §3. Fichiers : `realtime/realtime.gateway.ts` + `realtime/position-broadcast-buffer.service.ts` (+ tests).

### Obj 3 — Entrée vue groupée (réutilise S1) : pas de back spécifique
- Le veilleur lit `/vehicles/snapshot` (déjà scoping `accessibleVehicleIds`) → ne voit que ses groupes. Aucun nouvel endpoint.

### Obj 4 — Règle « 0 km depuis X min » (GLOBALE) — extension du garde-fou S2
- `engine-control.service.ts > requestCommand`, **bloc `action===CUT`**, après les checks S2 existants, **gardé par `if (requestedBy.role === UserRole.NIGHT_WATCHMAN)`** :
  - Constante `ENGINE_CUT_MIN_STOPPED_MS = max(0, Number(process.env.ENGINE_CUT_MIN_STOPPED_S) || 120) * 1000`.
  - **Exiger l'arrêt** : si `lastPosition.speedKmh > REST_SPEED_KMH` (5) → `REJECTED_SPEED` (« véhicule en mouvement »). *(Veilleur uniquement ; les admins gardent ≤ 20 km/h.)*
  - **Exiger la durée** : 2ᵉ requête `position.findFirst({ where:{ trackerId, speedKmh:{ gt: REST_SPEED_KMH }, timestamp:{ gte: now-fenêtreRecherche } }, orderBy:{timestamp:desc}, select:{timestamp:true} })`. `stoppedSince = lastMovement ? now-lastMovement.timestamp : now-lastPosition.timestamp`. Si `stoppedSince < ENGINE_CUT_MIN_STOPPED_MS` → `REJECTED_SPEED` + `lastError` clair (« arrêté depuis Ns, minimum X min »).
  - **Réutilise l'état `REJECTED_SPEED`** (pas de nouvel état) + `emitUpdate` (le front affiche un refus explicite, pas un échec générique).
- **Garde-fou borné** : `timestamp gte now - (ENGINE_CUT_MIN_STOPPED_MS + marge)` pour ne pas scanner tout l'historique (perf ; index `[trackerId, timestamp desc]`).
- **Portée** : **rôle veilleur uniquement** → aucune régression des tests/chemins S2 (acteur admin inchangé). Tests dédiés veilleur (refus si arrêté < 2 min / si en mouvement, OK si ≥ 2 min ; un admin n'est PAS soumis à la règle).

### Obj 5 — Désactivation auto horaire : PRÉSERVER
- Ne pas toucher le bloc `source==='MANUAL'` → `vehicleSchedule.updateMany` (disable / override 1 h). Les coupures veilleur sont `MANUAL` → s'applique déjà. **Tests de non-régression** dédiés.

### Toggle « gérer horaires » (Obj 1 bis)
- `vehicle-schedules.controller.ts` : ajouter `@RequirePermissions('schedules_manage')` (+ `@RequireVehiclePermission` si on veut le scope per-véhicule) et `NIGHT_WATCHMAN` au `@Roles`. Vérifier le scope (`accessibleVehicleIds`) dans le service.
- Réglage par l'admin : via l'endpoint/UX de permissions existant (`PATCH /users/:id` ou `SetUserAccess`) — `schedules_manage` passe par `clampPermissions` (anti-escalade). Aucun nouvel endpoint.

## 3. Front (réutilise guards/nav/login existants)

| Élément | Fichier | Changement |
|---|---|---|
| Onglets masqués | `layouts/dashboard-layout.component.ts` (`navItems`) | Si `role===NIGHT_WATCHMAN` → exposer **Véhicules uniquement** (liste groupée + détail) ; **masquer la Carte** et tout le reste (Trajets/Rapports, Alertes, Groupes, Users, Installation…). |
| Mini-carte du Détail (statique) | `features/vehicles/vehicle-detail.component.ts` (`<app-mini-map>`, `livePosition`) | Veilleur : afficher la **dernière position connue** (HTTP détail, scopée) — **non-interactive** + **sans live** : ne PAS alimenter la mini-carte avec `realtime.positions()` (WS). **Conserver `engineCommandUpdates()`** (WS) pour la confirmation/tri-état S2 (le veilleur en a besoin). |
| Anti-URL directe | `app.routes.ts` + `core/guards/` | `roleGuard`/`permissionGuard` sur **toutes** les routes interdites (dont `/map`) ; un veilleur hors périmètre → redirigé vers `/vehicles`. |
| Redirection login | `features/auth/login.component.ts` | Branche `role===NIGHT_WATCHMAN` → vue groupée. |
| Vue groupée par défaut | `features/vehicles/vehicles-list.component.ts` | Lire `?viewMode=grouped` à l'init **ou** forcer `grouped` pour le veilleur. (S1 réutilisée.) |
| Start/stop rapide | `features/engine-control/engine-control-button.component.ts` + carte | **Réutilise S2** (confirmation, tri-état, verrou 409, toasts). Rien de neuf. |
| UX « non vérifiable » | bouton/états S2 | Libellé rassurant déjà en place (S2). Vérifier la formulation pour le contexte veilleur. |
| UX refus 0 km | toast d'erreur | Message explicite « pas encore arrêté depuis assez longtemps » (mappé sur le `lastError` `REJECTED_SPEED`). |

> Rappel : le front est **cosmétique**. Le périmètre du veilleur est garanti **serveur** (§2). Les changements front = ergonomie + défense en profondeur.

## 4. Fichiers touchés (prévisionnel)
**Back** : `prisma/schema.prisma` (+migration enum) ; `permissions.ts` (shared) ; `users`/`invitations` (défauts + clamp de `schedules_manage`) ; `engine-control.controller.ts` (@Roles) ; `engine-control.service.ts` (règle 0 km) ; `vehicle-schedules.controller.ts` (perm+role) ; `vehicles.controller.ts` (role veilleur en lecture) ; `realtime/realtime.gateway.ts` + `realtime/position-broadcast-buffer.service.ts` (room `pos:fleet:X` = live coupé veilleur) ; `config/env.validation.ts` (ENGINE_CUT_MIN_STOPPED_S, optionnel).
**Front** : `dashboard-layout.component.ts` ; `app.routes.ts` (+ guard) ; `login.component.ts` ; `vehicles-list.component.ts`.
**Shared** : `permissions.ts`.

## 5. Plan de test (sécurité d'abord — sans jamais commander la prod)
Stratégie sans-prod de S2 (mocks registry/prisma/sms ; flotte CDEF interdite ; VPS lecture seule).
1. **Permissions/rôle** : un `NIGHT_WATCHMAN` peut `engine_control` (dans son scope) ; **403** sur `alerts/reports/users/drivers/geofences/sims` et `vehicle-schedules` (toggle OFF). Tests guard + e2e léger.
2. **Anti-URL directe** : route guard front (unit) **+** assert serveur 403 (le vrai gate).
3. **Scoping tenant + scope groupe** : un veilleur ne voit/commande que `accessibleVehicleIds` ; **404/403** cross-flotte (IDOR) et hors-groupe.
4. **Règle 0 km/X min (veilleur uniquement)** : pour un **veilleur** → refus `REJECTED_SPEED` si arrêté < 2 min **ou** si en mouvement (> `REST_SPEED_KMH`), OK si ≥ 2 min. Pour un **admin/manager → règle NON appliquée** (chemin ≤ 20 km/h S2 inchangé). **Tests S2 existants intacts** (acteur `fleetAdmin`).
5. **Toggle horaires** : `schedules_manage` OFF → 403 ; ON → autorisé (dans le scope) ; **clamp** anti-escalade (un granter sans la perm ne peut l'accorder).
6. **Mode horaire préservé** : un CUT/RESTORE `MANUAL` neutralise le schedule (disable/override) — non-régression.
7. **Anti-escalade** : `clampPermissions` sur `engine_control`/`schedules_manage`.
8. **Live coupé veilleur (serveur)** : un socket veilleur ne reçoit **pas** `POSITIONS_BATCH`/`POSITION_UPDATE` (room `pos:fleet:X` non rejointe) mais reçoit toujours `ENGINE_COMMAND_UPDATED` ; un non-veilleur reçoit le live normalement (non-régression). MAJ `position-broadcast-buffer.service.spec.ts`.

## 6. Workflow Git & DoD
- Branche `feat/sprint-3-veilleur-nuit` (worktree). **Rebase sur `main` une fois S2 mergé**, avant toute implémentation/merge. Commits atomiques `feat/fix/refactor/test/docs`.
- Ne rien merger soi-même ; préparer pour relecture en **mettant en avant tout ce qui touche aux permissions** (§2 + tests §5).
- DoD (brief) : rôle enforced serveur ✓, toggle horaires ✓, onglets masqués+URL bloquée ✓, login→vue groupée ✓, start/stop S2 réutilisé ✓, règle 0 km serveur ✓, mode horaire préservé ✓, scoping tenant ✓, zéro commande prod ✓, ANALYSE+PLAN+tests ✓.

## 7. Ordre d'implémentation (après go + S2 mergé)
1. Rebase sur `main`. 2. Enum rôle + migration + défauts perms (+`schedules_manage`). 3. Enforcement back engine-control/vehicles + **audit endpoints** (sécurité). 4. Règle 0 km globale + tests (+ MAJ tests S2). 5. Toggle horaires (perm+enforce) + tests. 6. Front : nav + guards + login + vue groupée. 7. Suite complète + typecheck + ng build. 8. RÉCAP (focalisé sécurité). 

## 8. Décisions tranchées (revue client — figées)
- **Règle 0 km/2 min = rôle veilleur uniquement** ; admins/managers gardent ≤ 20 km/h (**antivol préservé**). Zéro régression S2.
- **Pas de page Carte** pour le veilleur : seules pages = **liste groupée + Détail véhicule**. Sur le Détail, la mini-carte affiche la **dernière position connue, non-interactive, sans live** (« voir où est le véhicule sans voir le live »).
- **Seuil « mouvement »** = `REST_SPEED_KMH = 5` (cohérent S2).

### Décidé (client) — « sans live » SERVER-ENFORCED (room split)
**Constat** : le live WS est **scopé par flotte** (`realtime.gateway`: `client.join('fleet:${fleetId}')` ; positions émises vers `fleet:${fleetId}`), **pas par véhicule ni par permission** → un veilleur recevrait sinon le live de **toute la flotte** sur le fil.
**Implémentation** :
1. `realtime.gateway.ts > handleConnection` : tout le monde rejoint `fleet:${fleetId}` (commandes moteur, alertes, status) ; **les non-veilleurs rejoignent EN PLUS `pos:fleet:${fleetId}`** ; **le veilleur ne rejoint PAS `pos:fleet:*`**.
2. Émission des positions (`position-broadcast-buffer.service.ts` `POSITIONS_BATCH` + `realtime.gateway.broadcastPosition` `POSITION_UPDATE`) : cibler **`pos:fleet:${fleetId}`** au lieu de `fleet:${fleetId}`. Tout le reste (`ENGINE_COMMAND_UPDATED`, `TRACKER_STATUS`, `ALERT`) reste sur `fleet:${fleetId}`.
3. **Résultat** : le veilleur reçoit la confirmation moteur (S2) + alertes/status, mais **zéro position live** → vrai « sans live », et la fuite de scope live (flotte entière) est fermée pour lui.
> ⚠️ Touche le **gateway realtime** (sous-système partagé) : changement **contenu** (room cible des positions) + **MAJ tests** `position-broadcast-buffer.service.spec.ts` (room `pos:fleet:1`). À faire **après** rebase sur `main` (post-S2), suite realtime rejouée.
- **Sécurité #1 (priorité)** : enforcement serveur **exhaustif** + tests **403** sur **chaque** endpoint hors-périmètre (`alerts`, `reports`, `users`, `drivers`, `geofences`, `sims`, `installations`, `trips`, + `vehicle-schedules` si toggle OFF). **Aucun endpoint sous `JwtAuthGuard` seul.**
