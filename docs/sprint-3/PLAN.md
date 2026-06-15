# Sprint 3 — Rôle « Veilleur de nuit » · PLAN

> Phase 2. S'appuie sur `ANALYSE.md`. **Rien n'est implémenté** tant que (a) ce plan est validé et (b) **S2 est mergé**.
> **Base/branche** : `feat/sprint-3-veilleur-nuit` créée sur la **tête S2**. ⚠️ **Avant implémentation, une fois S2 mergé dans `main`, REBASE sur `main`** (qui contiendra S2). Si `main` bouge, on rejoue le rebase (comme S2).

## 0. Décisions actées (validées client)
1. **Scope veilleur** : **multi-groupes flexible** — 1..N groupes **ou** flotte entière, choisi par l'admin à la création, via `UserVehicleAccess` (`GROUP`/`ALL`). Aucune nouvelle table.
2. **Délai 0 km** : **défaut 2 min**, configurable via **env plateforme** `ENGINE_CUT_MIN_STOPPED_S` (défaut `120`). Config par-flotte = itération ultérieure (hors scope).
3. **Portée règle 0 km** : **GLOBALE — tous les rôles** (admins inclus). Régression assumée du comportement S2.
4. **Toggle « gérer horaires »** : **OFF par défaut** (moindre privilège).

> ### ⚠️ Implication de la décision #3 à CONFIRMER à la relecture (CB majeur)
> « Coupure autorisée seulement si 0 km depuis X min », appliquée **globalement**, **supersede** l'autorisation S2 de couper jusqu'à 20 km/h. **Conséquence : plus personne (admin compris) ne peut couper un véhicule qui roule, même lentement (5–20 km/h) — il faut qu'il soit à l'arrêt depuis ≥ X min.** Cas impacté : couper un véhicule **volé en mouvement lent** devient impossible jusqu'à son arrêt. C'est cohérent avec la sécurité S2 (interdit déjà > 20 km/h), mais c'est un **durcissement**. → **À confirmer.** (Repli possible si tu changes d'avis : porter la règle au **rôle veilleur uniquement** et garder ≤ 20 km/h pour les admins — 1 ligne de condition.)

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

### Obj 3 — Entrée vue groupée (réutilise S1) : pas de back spécifique
- Le veilleur lit `/vehicles/snapshot` (déjà scoping `accessibleVehicleIds`) → ne voit que ses groupes. Aucun nouvel endpoint.

### Obj 4 — Règle « 0 km depuis X min » (GLOBALE) — extension du garde-fou S2
- `engine-control.service.ts > requestCommand`, **bloc `action===CUT`**, après les checks S2 existants :
  - Constante `ENGINE_CUT_MIN_STOPPED_MS = max(0, Number(process.env.ENGINE_CUT_MIN_STOPPED_S) || 120) * 1000`.
  - **Exiger l'arrêt** : si `lastPosition.speedKmh > REST_SPEED_KMH` → `REJECTED_SPEED` (« véhicule en mouvement »). *(Durcit l'ancien ≤ 20 km/h — cf CB.)*
  - **Exiger la durée** : 2ᵉ requête `position.findFirst({ where:{ trackerId, speedKmh:{ gt: REST_SPEED_KMH }, timestamp:{ gte: now-fenêtreRecherche } }, orderBy:{timestamp:desc}, select:{timestamp:true} })`. `stoppedSince = lastMovement ? now-lastMovement.timestamp : now-lastPosition.timestamp`. Si `stoppedSince < ENGINE_CUT_MIN_STOPPED_MS` → `REJECTED_SPEED` + `lastError` clair (« arrêté depuis Ns, minimum X min »).
  - **Réutilise l'état `REJECTED_SPEED`** (pas de nouvel état) + `emitUpdate` (le front affiche un refus explicite, pas un échec générique).
- **Garde-fou borné** : `timestamp gte now - (ENGINE_CUT_MIN_STOPPED_MS + marge)` pour ne pas scanner tout l'historique (perf ; index `[trackerId, timestamp desc]`).
- **Portée** : globale (toutes sources/rôles), donc placée dans la précondition commune. *(Repli rôle-veilleur = condition `requestedBy.role === NIGHT_WATCHMAN` autour du bloc.)*

### Obj 5 — Désactivation auto horaire : PRÉSERVER
- Ne pas toucher le bloc `source==='MANUAL'` → `vehicleSchedule.updateMany` (disable / override 1 h). Les coupures veilleur sont `MANUAL` → s'applique déjà. **Tests de non-régression** dédiés.

### Toggle « gérer horaires » (Obj 1 bis)
- `vehicle-schedules.controller.ts` : ajouter `@RequirePermissions('schedules_manage')` (+ `@RequireVehiclePermission` si on veut le scope per-véhicule) et `NIGHT_WATCHMAN` au `@Roles`. Vérifier le scope (`accessibleVehicleIds`) dans le service.
- Réglage par l'admin : via l'endpoint/UX de permissions existant (`PATCH /users/:id` ou `SetUserAccess`) — `schedules_manage` passe par `clampPermissions` (anti-escalade). Aucun nouvel endpoint.

## 3. Front (réutilise guards/nav/login existants)

| Élément | Fichier | Changement |
|---|---|---|
| Onglets masqués | `layouts/dashboard-layout.component.ts` (`navItems`) | Si `role===NIGHT_WATCHMAN` → n'exposer que **Véhicules** (détail atteint via la liste). |
| Anti-URL directe | `app.routes.ts` + `core/guards/` | `roleGuard`/`permissionGuard` sur les routes interdites ; un veilleur sur une route hors périmètre → redirigé vers `/vehicles`. |
| Redirection login | `features/auth/login.component.ts` | Branche `role===NIGHT_WATCHMAN` → vue groupée. |
| Vue groupée par défaut | `features/vehicles/vehicles-list.component.ts` | Lire `?viewMode=grouped` à l'init **ou** forcer `grouped` pour le veilleur. (S1 réutilisée.) |
| Start/stop rapide | `features/engine-control/engine-control-button.component.ts` + carte | **Réutilise S2** (confirmation, tri-état, verrou 409, toasts). Rien de neuf. |
| UX « non vérifiable » | bouton/états S2 | Libellé rassurant déjà en place (S2). Vérifier la formulation pour le contexte veilleur. |
| UX refus 0 km | toast d'erreur | Message explicite « pas encore arrêté depuis assez longtemps » (mappé sur le `lastError` `REJECTED_SPEED`). |

> Rappel : le front est **cosmétique**. Le périmètre du veilleur est garanti **serveur** (§2). Les changements front = ergonomie + défense en profondeur.

## 4. Fichiers touchés (prévisionnel)
**Back** : `prisma/schema.prisma` (+migration enum) ; `permissions.ts` (shared) ; `users`/`invitations` (défauts + clamp de `schedules_manage`) ; `engine-control.controller.ts` (@Roles) ; `engine-control.service.ts` (règle 0 km) ; `vehicle-schedules.controller.ts` (perm+role) ; `vehicles.controller.ts` (role veilleur en lecture) ; `config/env.validation.ts` (ENGINE_CUT_MIN_STOPPED_S, optionnel).
**Front** : `dashboard-layout.component.ts` ; `app.routes.ts` (+ guard) ; `login.component.ts` ; `vehicles-list.component.ts`.
**Shared** : `permissions.ts`.

## 5. Plan de test (sécurité d'abord — sans jamais commander la prod)
Stratégie sans-prod de S2 (mocks registry/prisma/sms ; flotte CDEF interdite ; VPS lecture seule).
1. **Permissions/rôle** : un `NIGHT_WATCHMAN` peut `engine_control` (dans son scope) ; **403** sur `alerts/reports/users/drivers/geofences/sims` et `vehicle-schedules` (toggle OFF). Tests guard + e2e léger.
2. **Anti-URL directe** : route guard front (unit) **+** assert serveur 403 (le vrai gate).
3. **Scoping tenant + scope groupe** : un veilleur ne voit/commande que `accessibleVehicleIds` ; **404/403** cross-flotte (IDOR) et hors-groupe.
4. **Règle 0 km/X min (globale)** : refus `REJECTED_SPEED` si arrêté < X min ; OK si ≥ X min ; refus si en mouvement (> REST_SPEED_KMH) ; **vérifier l'application aux admins** (décision #3). + **MAJ des tests S2** impactés (cuts à l'arrêt doivent mocker « dernier mouvement > X min »).
5. **Toggle horaires** : `schedules_manage` OFF → 403 ; ON → autorisé (dans le scope) ; **clamp** anti-escalade (un granter sans la perm ne peut l'accorder).
6. **Mode horaire préservé** : un CUT/RESTORE `MANUAL` neutralise le schedule (disable/override) — non-régression.
7. **Anti-escalade** : `clampPermissions` sur `engine_control`/`schedules_manage`.

## 6. Workflow Git & DoD
- Branche `feat/sprint-3-veilleur-nuit` (worktree). **Rebase sur `main` une fois S2 mergé**, avant toute implémentation/merge. Commits atomiques `feat/fix/refactor/test/docs`.
- Ne rien merger soi-même ; préparer pour relecture en **mettant en avant tout ce qui touche aux permissions** (§2 + tests §5).
- DoD (brief) : rôle enforced serveur ✓, toggle horaires ✓, onglets masqués+URL bloquée ✓, login→vue groupée ✓, start/stop S2 réutilisé ✓, règle 0 km serveur ✓, mode horaire préservé ✓, scoping tenant ✓, zéro commande prod ✓, ANALYSE+PLAN+tests ✓.

## 7. Ordre d'implémentation (après go + S2 mergé)
1. Rebase sur `main`. 2. Enum rôle + migration + défauts perms (+`schedules_manage`). 3. Enforcement back engine-control/vehicles + **audit endpoints** (sécurité). 4. Règle 0 km globale + tests (+ MAJ tests S2). 5. Toggle horaires (perm+enforce) + tests. 6. Front : nav + guards + login + vue groupée. 7. Suite complète + typecheck + ng build. 8. RÉCAP (focalisé sécurité). 

## 8. Questions ouvertes / à confirmer
- **CB décision #3** (cf encadré §0) : confirmer le durcissement global (5–20 km/h non coupable) ou replier sur veilleur-only.
- **Carte pour le veilleur ?** Le brief dit « Véhicules + Détail » uniquement → **je masque la Carte** au veilleur (à confirmer ; certains veilleurs aiment la carte, mais le brief est explicite).
- **Seuil « mouvement »** pour la durée d'arrêt : on réutilise `REST_SPEED_KMH=5` (cohérent S2) plutôt qu'un `> 0` strict (bruit GPS). OK ?
