# Sprint 2 — Fiabilisation du start/stop · PLAN (Phase 2)

> Suite de `ANALYSE.md`. **Décisions validées** : confirmation **par ignition** (l'état ne bascule « coupé » qu'à la preuve réelle) · état **« non vérifiable » explicite** pour les cas à l'arrêt / RESTORE.
> Principe : **durcir l'existant**. On réutilise la machinerie qui marche (détection d'ignition `DEVICE_OBSERVED`, `AckWaiter`, `registry.send`, WS `engine-command:updated`). On **ne réécrit pas** le dispatch.

---

## A. Machine à états d'une commande moteur (affichée)

Dérivée de `(status, source, confirmationExpected, ackedAt, age = now - sentAt)`. Fenêtre `CONFIRM_WINDOW` = **90 s** (env-configurable ; couvre ~2-3 trames Coban).

| État affiché | Condition | UI |
|---|---|---|
| **Refusée** | `status=REJECTED_SPEED` | ⛔ raison (vitesse/fix/stale) |
| **Échec d'envoi** | `status=FAILED` | ❌ « non envoyée » (offline + pas de SMS) |
| **Envoyée — en attente** | `SENT, ackedAt=null, confirmationExpected=true, age<90s` | ⏳ « envoyée, attente confirmation » |
| **Non confirmée** | `SENT, ackedAt=null, confirmationExpected=true, age≥90s` | ⚠️ « envoyée, NON confirmée — vérifier » |
| **Non vérifiable** | `SENT, ackedAt=null, confirmationExpected=false` | « envoyée — confirmation indisponible (véhicule à l'arrêt / rallumage) » |
| **Confirmée** | `status=ACKNOWLEDGED` (ackedAt set), source≠DEVICE_OBSERVED | ✅ « confirmée par le boîtier » |
| **Externe (device)** | source=DEVICE_OBSERVED (toujours ACKNOWLEDGED) | « coupure/rallumage détecté boîtier » |

**État physique `engineCutActive` (« le moteur EST coupé »)** = le dernier CUT **confirmé** (status `ACKNOWLEDGED`, **toutes sources DEVICE_OBSERVED incluses**) est plus récent que le dernier RESTORE confirmé.
→ **Une CUT `SENT` non confirmée ne met PAS `engineCutActive=true`** (l'état ne bascule qu'à la preuve — D1). C'est le changement de comportement central.

---

## B. Modèle de données

- **Migration additive (1 colonne)** : `EngineControlCommand.confirmationExpected Boolean @default(false)`.
  - `true` ⇔ une chute d'ignition est attendable comme preuve : `action=CUT` ET ignition réellement ON à l'envoi (`lastPosition.ignition === true`).
  - `false` ⇔ RESTORE, ou CUT d'un véhicule déjà à l'arrêt (ignition OFF/inconnue) → état « non vérifiable ».
  - Backward-compatible : les lignes existantes → `false` (donc « non vérifiable », neutre).
- **Réutilisation** : `status=ACKNOWLEDGED` + `ackedAt` = « confirmée » (par ignition **ou** par écho fil rare). Pas de nouvel enum.
- Migration générée via Prisma (additive, `NOT NULL DEFAULT false`), appliquée par `prisma migrate deploy` au boot (déjà câblé). **Signalé comme changement de schéma.**

---

## C. Backend — par objectif

### Obj 1 — Idempotence / une seule commande en vol (`engine-control.service.ts`)
- **Verrou serveur** en tête de `requestCommand` (avant création) : rejeter (`ConflictException` 409) s'il existe déjà une commande **en vol** sur ce tracker :
  `status=PENDING` **OU** (`status=SENT, ackedAt=null, createdAt > now-90s`).
  → couvre double-clic **et** voies multiples (toute nouvelle commande, quelle que soit la source app, est bloquée tant que la précédente n'est ni confirmée ni périmée). Le verrou se **libère** dès confirmation (`ackedAt`) ou après la fenêtre (→ « non confirmée »).
- `SCHEDULER`/`DEVICE_OBSERVED` exemptés du rejet (le scheduler ne doit pas 409 ; le device-observed n'appelle pas `requestCommand`). Le lock vise les commandes **app** concurrentes.
- **Id de corrélation** = `command.id` (uuid), déjà présent ; on le propage partout (logs/WS/wire) — cf. Obj 5.

### Obj 2 — Confirmation réelle (le cœur)
1. `requestCommand`/`dispatchCommand` : calculer `confirmationExpected = (action===CUT && lastPosition?.ignition===true)` et le persister à la création. (RESTORE → false ; CUT à l'arrêt → false.)
2. `dispatchCommand` : **inchangé** sur l'envoi (TCP→SMS, `SENT` à l'écriture). On garde l'`AckWaiter` J/K (écho rare) qui, s'il match, pose `ACKNOWLEDGED` (= confirmé).
3. **Confirmation par ignition** (`positions.service.ts` `handleIgnitionTransition`, branche ON→OFF avec `recentCut`) : aujourd'hui « ne fait rien ». → **marquer `recentCut` confirmé** : `status=ACKNOWLEDGED, ackedAt=now`, `reason` annotée « confirmé par chute d'ignition », **émettre WS**. C'est la preuve réelle reliée à la commande.
4. Le timeout `AckWaiter` reste **non-FAILED** (inchangé, V1.15). La transition vers « non confirmée » est **dérivée** (age ≥ 90 s), pas un statut DB → pas de faux FAILED.

### Obj 3 — Source de vérité = device (`vehicles.service.ts` snapshot + back)
- `engineCutActive` : **inclure DEVICE_OBSERVED** et ne compter que les CUT/RESTORE **confirmés** (`status=ACKNOWLEDGED`, toutes sources). Remplace `source: { not: 'DEVICE_OBSERVED' }` (l.513) par « dernier CUT confirmé vs dernier RESTORE confirmé, toutes sources ». (Dédup déjà gérée par la fenêtre 5 min de `handleIgnitionTransition`.)
- Conséquence : une coupure SMS manuelle (DEVICE_OBSERVED CUT) **fait** basculer le badge « coupé ». ✅ obj 3.

### Obj 4 — Voies & fallback & anti-double-exécution
- Matrice (cf. ANALYSE §2.5) inchangée sur les **transports** (TCP prioritaire → SMS fallback, séquentiel). On **documente** la priorité et on ajoute la **garde anti-double-exécution = le verrou Obj 1** (empêche app-CUT de courir avec une autre commande app sur le même tracker dans la fenêtre).
- Pas de nouvelle voie. On ne touche pas à `TrackerCommands` (moteur déjà interdit).

### Obj 5 — Observabilité / corrélation
- Logs structurés des **transitions** avec `{ commandId, trackerId, fleetId, imei, from, to, channel, latencyMs }` : PENDING→SENT, SENT→ACKNOWLEDGED(confirmé:ignition|wire), SENT→(non confirmée à la fenêtre), FAILED, REJECTED.
- **Sentinelle « non confirmée »** (léger) : à l'envoi d'une CUT `confirmationExpected=true`, armer un check différé (90 s) ; si toujours `SENT, ackedAt=null` → `ErrorLogger.record(WARNING 'engine cut unconfirmed')` (observabilité, **pas** FAILED) + WS d'état. Donne au centre d'alerte la visibilité des coupures non confirmées.
- WS `emitEngineCommandUpdate` : enrichir le payload de `confirmationExpected`, `ackedAt`, `sentAt` pour que le front dérive l'état sans refetch.

### Sécurité (NE PAS régresser)
- Scoping tenant déjà appliqué (`where.vehicle.fleetId`), conservé sur toutes les nouvelles lectures (lock query incluse → filtrer par tracker, déjà tenant-checké en amont).
- Sanitisation webhook/`raw`/IMEI binding : **non touchée**. Tests de non-régression conservés.

---

## D. Frontend

- **DTO** (`core/services/engine-control.service.ts`) : `EngineControlCommandDto` + `confirmationExpected`, `ackedAt`, `sentAt` (déjà), `source`.
- **Bouton** (`features/engine-control/engine-control-button.component.ts`) :
  - `isCutActive()` → ne compter « coupé » que sur **confirmé** (`ACKNOWLEDGED`, toutes sources DEVICE_OBSERVED incluses) — plus de « coupé » sur `SENT`.
  - **État de la dernière commande** (computed) = la machine §A → afficher ⏳ / ⚠️ / « non vérifiable » / ✅ sous le bouton, avec un **timer local** qui bascule « en attente »→« non confirmée » à 90 s.
  - **Anti multi-clic** : garde `loading` conservée ; sur **409** du back → toast « Une commande est déjà en cours sur ce véhicule ».
  - Toast post-envoi : « Commande envoyée — en attente de confirmation » (au lieu de « Moteur coupé »).
- **Realtime** (`core/services/realtime.service.ts`) : `engineCommandUpdates` enrichi (confirmationExpected/ackedAt) ; `cutActiveTrackerIds` ne s'active que sur **confirmé**.
- **Carte** (`map.component.ts`) : `patchIgnitionFromCommands` ne doit plus « pré-couper » sur `SENT` (c'était le faux succès) → patch uniquement sur **confirmé**. Bottom card : même état que le bouton.

---

## E. Tests (automatisés, SANS PROD — 100 % mocks)

- `engine-control.service.spec.ts` : 
  - idempotence : 2ᵉ commande en vol → 409 ; libérée après confirmation / fenêtre.
  - `confirmationExpected` : CUT ignition ON → true ; CUT à l'arrêt → false ; RESTORE → false.
  - dispatch TCP OK → SENT ; TCP KO + SMS → SENT(via SMS) ; TCP KO + pas de SIM → FAILED.
  - scoping/IDOR conservé.
- `positions.service` (spec ciblé) : ignition ON→OFF avec `recentCut` app → commande passée ACKNOWLEDGED + WS ; sans recentCut → DEVICE_OBSERVED (inchangé).
- `vehicles.service.spec.ts` : `engineCutActive` inclut DEVICE_OBSERVED + ne compte que confirmé (CUT confirmé > RESTORE confirmé).
- `ack-waiter.service.spec.ts` : inchangé (priorité) — non-régression.
- Sanitisation (`coban.catalog`/webhook) : tests existants restent verts (non-régression).
- Front : état de la dernière commande (en attente/non confirmée/non vérifiable/confirmé), anti multi-clic + gestion 409.

**Vérif** : `pnpm --filter @vizyo/tracky-{api,shared} typecheck`+`test` ; web → `ng build`. (Gotcha worktree : `prisma generate` + build `shared` — cf. mémoire.)

---

## F. Fichiers touchés (prévision)

**Backend**
- `apps/api/prisma/schema.prisma` (+ migration) — `confirmationExpected`.
- `apps/api/src/engine-control/engine-control.service.ts` — lock 409, `confirmationExpected`, logs corrélés, sentinelle non-confirmée.
- `apps/api/src/positions/positions.service.ts` — confirmation par ignition (relier `recentCut`).
- `apps/api/src/vehicles/vehicles.service.ts` — `engineCutActive` toutes sources + confirmé.
- `apps/api/src/realtime/realtime.gateway.ts` (+ shared events) — payload WS enrichi.
- `apps/api/src/engine-control/engine-control.controller.ts` — surface DTO (confirmationExpected/ackedAt) si mapping.
- specs associés.

**Frontend**
- `apps/web/src/app/core/services/engine-control.service.ts` — DTO.
- `apps/web/src/app/features/engine-control/engine-control-button.component.ts` — états + 409 + timer.
- `apps/web/src/app/core/services/realtime.service.ts` — état confirmé.
- `apps/web/src/app/features/map/map.component.ts` — patch optimiste → confirmé only.

---

## G. Découpage en commits atomiques (prévision)
1. `docs(sprint-2)` analyse + plan (analyse déjà commitée).
2. `feat(engine): colonne confirmationExpected + migration`.
3. `feat(engine): verrou une-commande-en-vol (409) + tests` (obj 1).
4. `feat(engine): confirmation par chute d'ignition + etat non-verifiable + tests` (obj 2).
5. `fix(engine): engineCutActive = etat device confirme (inclut DEVICE_OBSERVED)` (obj 3).
6. `feat(engine): logs correles + sentinelle non-confirmee + WS enrichi` (obj 5).
7. `feat(web): UX confirmation (en attente/non confirmee/non verifiable/confirme) + anti 409`.
8. `test(...)` compléments.

---

## H. Changements de comportement (à mettre en évidence pour la relecture)
- **CB1** : « coupé » ne s'affiche plus à l'envoi — seulement à la **confirmation réelle** (ignition) ou détection device. Une CUT envoyée mais non confirmée = ⚠️/non-vérifiable, **jamais** « coupé ».
- **CB2** : une coupure **hors app** (SMS manuel) bascule désormais le badge « coupé » (avant : ignorée à l'affichage).
- **CB3** : une 2ᵉ commande pendant qu'une est en vol est **rejetée (409)** au lieu d'être exécutée.
- **CB4** : migration additive (`confirmationExpected`).

## I. Vérification staging avant prod (sans toucher la prod)
- Tests auto verts (mocks).
- Staging : tracker de test (IMEI factice, pas de socket réel) → `registry.send=false` simule offline ; provider SMS `noop`. Valider : lock 409, état « non vérifiable », et simulation d'une transition d'ignition (injection d'une position de test) → passage « confirmée » + badge « coupé ». **Aucun device réel, jamais la flotte CDEF.**
