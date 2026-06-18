# Sprint 2 — Fiabilisation du start/stop · RÉCAP (pour relecture)

> Branche `feat/sprint-2-fiabilisation-commande` (worktree isolé) · base `main` @ `a316347`.
> ⚠️ **Feature de SÉCURITÉ** (coupe-circuit moteur physique). **Ne pas merger sans validation.**

## Corrections post-revue (code-review du 2026-06-14)
La relecture (high-effort, 4 angles + vérif) a confirmé l'architecture et relevé 6 points, **tous corrigés** (commits `fix(engine|web): revue Sprint 2 …`) :
1. **#1 (critique) — rallumage « collé »** : dériver l'état coupé uniquement sur `ACKNOWLEDGED` cassait le RESTORE (un RESTORE app n'atteint jamais `ACKNOWLEDGED`) → le badge « coupé » restait affiché à vie après un rallumage. **Corrigé partout** (snapshot back, realtime, bouton, carte) : un RESTORE plus récent (SENT||ACK) nettoie l'état.
2. **#2 — tri-état** (décision validée) : `normal` / `pending` (envoyée non confirmée, ex. véhicule à l'arrêt) / `cut` (confirmée). Nouveau champ `engineCutState` au snapshot ; badge ambre « Coupure en attente » sur la carte.
3. **#3 — verrou 409 MANUEL only** : le SCHEDULER n'est plus bloqué par une coupure manuelle en attente (il ré-évalue à chaque tick).
4. **#4 — faux succès carte** : le popup carte affichait « Moteur coupé » au simple envoi → remplacé par « Coupure envoyée » + attente de confirmation ; gestion dédiée du 409.
5. **#5 — confirmation gardée** : la chute d'ignition ne confirme que les coupures `confirmationExpected` (une coupure à l'arrêt n'est plus faussement confirmée par une transition ON/OFF ultérieure).
6. **#6 — verrou borné** : la fenêtre borne aussi les `PENDING` orphelins (anti-blocage permanent si un dispatch crashe).

Procédure de validation staging « à l'œil » : [`STAGING-VALIDATION.md`](./STAGING-VALIDATION.md).

## Investigation préalable (demandée : le statut Coban expose-t-il l'état du relais ?)
**Non — confirmé par la doc ET par les données prod.**
- **Doc protocole** (`docs/03`) : aucun champ « relais/sortie » ; la confirmation documentée = l'`ignition` de la trame de position suivante (timeout 120 s). C'est exactement le design retenu.
- **Données prod** (`wire_logs`, 242k trames IN, 1 semaine) : les trames `status` sont un **heartbeat statique ~5 min** (sur le tracker le plus actif, 1539 trames **identiques à l'octet près** ; aucun champ ne bascule lors d'une coupure). **0 ACK fil réel** sur ~169 commandes app.
→ Pour un véhicule **à l'arrêt**, le hardware ne fournit aucune preuve de coupure → l'état **« non vérifiable »** (validé) est le bon choix honnête. La **confirmation par ignition** reste la voie primaire.

## Les 5 objectifs livrés
1. **Idempotence (Obj 1)** — verrou serveur **409** : une nouvelle coupure est rejetée tant qu'une coupure **confirmable** est en vol (SENT + `confirmationExpected` + dans la fenêtre). **Ajusté** (demande) : **ne bloque PAS le RESTORE** (échappatoire sûr) ni une coupure **non vérifiable** (à l'arrêt). Côté front : garde `loading` + gestion du 409.
2. **Confirmation réelle (Obj 2)** — l'état « coupé » **ne bascule qu'à la chute d'ignition** : `positions.service.handleIgnitionTransition` relie la commande app `SENT` → `ACKNOWLEDGED` (preuve physique). Sinon, le front affiche un état honnête : **en attente** → **non confirmée** (fenêtre `ENGINE_CONFIRM_WINDOW_S`, défaut **90 s**, env) ou **non vérifiable** (à l'arrêt / RESTORE). `confirmationExpected` (CUT véhicule en marche) persisté. **Plus de faux succès.**
3. **Source de vérité = device (Obj 3)** — `engineCutActive` (snapshot back + front `isCutActive` + realtime `cutActiveTrackerIds` + carte) = dernière commande **CONFIRMÉE** (ACKNOWLEDGED), **toutes sources** → une coupure **SMS externe** (DEVICE_OBSERVED) bascule désormais le badge. Une coupure seulement `SENT` ne bascule plus.
4. **Voies & fallback (Obj 4)** — matrice documentée (ANALYSE §2.5) : **TCP prioritaire → fallback SMS** (séquentiel, pas de double-exécution intra-dispatch). Garde anti-double-exécution = le verrou Obj 1. Pas de nouvelle voie ; `TrackerCommands` (moteur interdit) non touché.
5. **Observabilité (Obj 5)** — **sentinelle** : une coupure confirmable non confirmée dans la fenêtre est tracée au **centre d'alerte** (WARNING, **pas** un FAILED). WS enrichi (`confirmationExpected`/`sentAt`/`ackedAt`/`source`). `commandId` corrélé dans les logs/WS.

## Changements de comportement (à mettre en évidence)
- **CB1** — « coupé » s'affiche seulement à la **confirmation réelle** (ignition), jamais à l'envoi.
- **CB2** — une **coupure SMS hors app** bascule désormais le badge (avant : détectée mais invisible).
- **CB3** — une 2ᵉ coupure pendant qu'une est en vol → **409** (le RESTORE n'est jamais bloqué).
- **CB4** — **migration additive** `EngineControlCommand.confirmationExpected`.

## Sécurité (NON régressée)
- **Scoping tenant / IDOR** : inchangé (`where.vehicle.fleetId`) ; la requête du verrou porte sur le tracker déjà tenant-vérifié. RESTORE toujours autorisé (positif).
- **Sanitisation** : webhook HMAC + anti-replay + fail-closed, charset `raw`, binding IMEI entrant → **non touchés**.

## Tests & vérification — SANS PROD
- **100 % mocks** (registry / prisma / sms / ackWaiter). **Aucune commande réelle envoyée. Flotte CDEF jamais touchée.** VPS = **lecture seule** (analyse + `wire_logs`).
- **Backend** : tests engine-control (verrou 409, RESTORE non bloqué, **SCHEDULER non bloqué**, **fenêtre du verrou**, `confirmationExpected` marche/arrêt/RESTORE) ; +1 positions (confirmation par chute d'ignition) ; +1 vehicles (**snapshot tri-état** cut/pending/normal-après-RESTORE). **Suite API : 38 suites / 416 tests OK.** `typecheck` shared+api **OK**.
- **Front** : **`ng build` OK**. La machine à états est dérivée de données backend (testées) ; le front les affiche (en attente / confirmée / non confirmée / non vérifiable / échec).
- Couverture DoD : idempotence (verrou 409), timeout/échec (SENT≠FAILED + non confirmée dérivée), synchro bidirectionnelle (confirmation ignition + DEVICE_OBSERVED), scoping tenant (tests IDOR existants préservés).

## Vérif staging avant prod (sans toucher la prod)
1. Tests auto verts (mocks).
2. Staging : **tracker de test** (IMEI factice, pas de socket réel) → `registry.send=false` simule offline ; provider SMS **noop**. Valider : verrou 409, état « non vérifiable », puis **injection d'une position de test** (ignition ON→OFF) → passage « confirmée » + badge « coupé ». **Jamais un device réel, jamais la flotte CDEF.**
3. **Migration** : `confirmationExpected` (additive `NOT NULL DEFAULT false`) appliquée par `prisma migrate deploy` au boot — backward-compatible.

## Réglages
- `ENGINE_CONFIRM_WINDOW_S` (env, défaut 90) = fenêtre d'attente de confirmation = durée du verrou. La doc cite 120 s ; ajustable sans redéploiement de code.

## Commits
```
docs(sprint-2): analyse + plan
feat(engine): colonne confirmationExpected + migration
feat(engine): verrou une-coupure-en-vol (409) + confirmationExpected + WS enrichi
feat(engine): confirmation par chute d'ignition (positions)
fix(engine): engineCutActive = etat device confirme (inclut DEVICE_OBSERVED)
feat(web): UX confirmation start/stop (etats reels, anti faux-succes) + 409
docs(sprint-2): recap de relecture
fix(engine): revue Sprint 2 backend - coupe tri-etat, verrou MANUAL, confirmation gardee
fix(web): revue Sprint 2 front - coupe tri-etat (carte/badge), rallumage nettoie, 409 carte
```
