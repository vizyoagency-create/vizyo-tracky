# Sprint 6 — Rétention & archivage — PLAN (Phase 2)

> Suite de `ANALYSE.md` (3 points validés : préventif/volumétrie · IN=positions only · cron-delete + createdAt + archive logique). Branche `feat/sprint-6-retention-archivage`.
> **CRITIQUE — supprime de la donnée.** **STOP en fin de doc** : valider suppression + migration avant d'implémenter.

## Ordre d'implémentation (commits atomiques, par étapes vérifiables)
1. Migration index `positions(createdAt)` + env (durées + flag).
2. Pipeline rétention (dry-run par défaut + fenêtre archive + flag) — cœur.
3. Snapshot + service de stats (pour les vues, perf).
4. Vues super-admin / fleet / prochaines suppressions.
5. Tests (périmètre, idempotence, bornage, dry-run, flag, S5).

---

## 1. Config — durées configurables + flag de suppression (`env.validation.ts`)

```ts
POSITIONS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(365), // actif (0 = tout désactivé)
POSITIONS_ARCHIVE_DAYS:   z.coerce.number().int().nonnegative().default(30),  // préavis récupérable
POSITIONS_PURGE_ENABLED:  z.string().default('false'),                        // 'true' = suppression RÉELLE ; sinon DRY-RUN
```
- **Suppression OFF par défaut** : `POSITIONS_PURGE_ENABLED='false'` ⇒ le cron tourne en **dry-run** (calcule + journalise + snapshot, **n'efface rien**).
- Seuil de suppression = `createdAt < now - (RETENTION_DAYS + ARCHIVE_DAYS)` = **395 j** par défaut.
- **Global** (env) pour commencer ; per-flotte = évolution future (non fait ici, noté).

## 2. Migration — index `positions(createdAt)` (NON bloquant)
- But : purge par lots efficace sur la date d'ancrage (l'index actuel `(trackerId, timestamp)` ne sert pas une purge globale par `createdAt`).
- **Prod (148 Mo)** : `CREATE INDEX CONCURRENTLY IF NOT EXISTS positions_createdAt_idx ON positions("createdAt")` — **aucun lock** (CONCURRENTLY), ~secondes. Exécuté hors transaction.
  - Prisma migrate étant transactionnel, on crée l'index **manuellement en prod** (commande CONCURRENTLY) lors du déploiement, ET on déclare `@@index([createdAt])` dans le schéma + une migration `CREATE INDEX IF NOT EXISTS` (idempotente : no-op si déjà créé, brève sur une petite/nouvelle base). Détaillé dans le PLAN de déploiement.
- **Rollback** : `DROP INDEX CONCURRENTLY IF EXISTS positions_createdAt_idx` (réversible, l'index n'est qu'une optimisation).
- Aucune autre modif de schéma sur `positions` (pas de colonne, pas de mouvement de données).

## 3. Pipeline rétention — `data-retention.service.ts` (refactor de `purgePositions`)

Cron existant `@Cron('0 30 3 * * *')` + verrou anti-chevauchement (`private running`) + try/catch. `runOnce()` :

```
retentionDays = cfg(POSITIONS_RETENTION_DAYS); if (retentionDays <= 0) return;   // 0 = désactivé
archiveDays   = cfg(POSITIONS_ARCHIVE_DAYS);
purgeEnabled  = cfg(POSITIONS_PURGE_ENABLED) === 'true';

now = new Date();
archiveFrom = now - retentionDays*DAY;                 // au-delà = archive/préavis
deleteFrom  = now - (retentionDays+archiveDays)*DAY;   // au-delà = à supprimer

// 1) DRY-RUN TOUJOURS : on COMPTE (pas de delete)
toDelete  = count(positions WHERE createdAt < deleteFrom)        // ce qui SERAIT supprimé
inArchive = count(positions WHERE createdAt BETWEEN deleteFrom..archiveFrom)
active    = count(positions WHERE createdAt >= archiveFrom)
log + updateSnapshot(global+per-fleet, mode = purgeEnabled?'REAL':'DRY_RUN', counts, nextDeletionAt)

// 2) SUPPRESSION RÉELLE seulement si purgeEnabled
if (!purgeEnabled) { log('DRY-RUN: ' + toDelete + ' position(s) seraient supprimees, 0 effacee'); return; }
let total=0, batches=0;
for (;;) {
  deleted = $executeRaw(`DELETE FROM positions WHERE id IN (
     SELECT id FROM positions WHERE "createdAt" < $1 LIMIT ${BATCH} )`, deleteFrom);  // BATCH=10000
  total += deleted; batches++;
  if (deleted < BATCH || batches >= MAX_BATCHES_PER_RUN) break;   // BORNE anti-emballement (ex. 50 lots = 500k/run)
}
log('Purge: ' + total + ' position(s) supprimees par lots')
```
- **Idempotent** (re-calcul depuis la DB à chaque tick), **borné** (`MAX_BATCHES_PER_RUN`), **non bloquant** (lots de 10k), **journalisé** précisément.
- **Périmètre absolu** : la SEULE requête `DELETE` cible `positions`. Aucune autre table touchée.
- `sampling_decisions` / `wire_logs` / `error_logs` : inchangés (déjà retenus ailleurs).

## 4. Snapshot pour les vues (perf) — `RetentionSnapshot`
- Les positions n'ont pas de `fleetId` direct (positions→tracker→vehicle→fleet) → un GROUP BY par flotte sur 628k lignes à chaque ouverture de vue serait coûteux. ⇒ **le cron calcule + persiste un snapshot**, les vues le lisent (rapide).
- Table `retention_snapshots` (append/upsert) : `scope` ('GLOBAL' | fleetId), `activeCount`, `archiveCount`, `toDeleteCount`, `oldestCreatedAt`, `nextDeletionAt`, `mode`, `computedAt`.
- Mis à jour à chaque run du cron + **bouton « Rafraîchir » super-admin** (recalcul à la demande, lecture seule).
- (Migration : créer `retention_snapshots`. Petite table, sans risque.)

## 5. Vues de suivi (3) — `reports_view`/super-admin scopées
- **GET `/admin/retention`** (SUPER_ADMIN) : état global — total positions, actif/archive/à-supprimer (+ tailles estimées), durées config, **mode (DRY-RUN/REEL)**, prochaine suppression (date + volume). Bouton « Rafraîchir ».
- **GET `/retention/fleet`** (FLEET_ADMIN, sa flotte ; SUPER_ADMIN any) : pour la flotte — ses positions, ancienneté, ce qui passera en archive / sera supprimé et **quand** (préavis).
- **« Prochaines suppressions »** (section des deux vues) : volume + date d'échéance, lisible, à partir du snapshot.
- Front : un écran **Administration → Rétention** (super-admin, global + prochaines suppressions) + un encart côté fleet. Mobile-friendly, design system existant.

## 6. Cohérence S5 (rapports sur période purgée)
- Rapports/KPIs/Excel = via `trips` → inchangés.
- Replay vieux trajet → fallback compact (polyline Trip) déjà en place.
- Export CSV positions / recompute sur période purgée → **message clair** « données conservées seulement sur la fenêtre de rétention (X jours) » plutôt qu'un vide trompeur.

## 7. Fichiers touchés
`env.validation.ts` · `schema.prisma` (+`@@index([createdAt])` Position, +`RetentionSnapshot`) + migration(s) · `data-retention.service.ts` (pipeline dry-run/flag/archive/snapshot) · nouveau `retention-stats.service.ts` (+ snapshot) · `retention.controller.ts` (+ module) · front (écran Rétention + encart fleet) · specs.

## 8. Plan de test
- **Périmètre (priorité)** : un test prouve que le pipeline n'émet de `DELETE` que sur `positions` ; les autres tables (users/vehicles/trips/etc.) intactes (mock Prisma : seul `positions` reçoit un delete).
- **Dry-run** : `PURGE_ENABLED=false` ⇒ compte mais **0 delete** (le `$executeRaw` DELETE n'est jamais appelé).
- **Flag réel** : `PURGE_ENABLED=true` ⇒ delete par lots ; **bornage** (`MAX_BATCHES_PER_RUN` respecté) ; idempotence (2 runs).
- **Seuils** : positions < 365j gardées, [365–395] en archive (gardées), > 395j supprimées (en mode réel).
- **Snapshot/vues** : counts corrects par fenêtre, scoping fleet (un fleet ne voit que sa flotte).
- **S5** : message propre sur période purgée.

## 9. Rollback (documenté)
- **Pipeline** : `POSITIONS_PURGE_ENABLED=false` → retour **instantané** en dry-run (plus aucune suppression). `POSITIONS_RETENTION_DAYS=0` → désactive tout.
- **Index** : `DROP INDEX CONCURRENTLY` (l'index n'est qu'une optimisation).
- **Snapshot** : table additive, supprimable.
- **Données** : **archive = fenêtre logique, aucun déplacement** → rien à « dé-archiver ». La seule étape irréversible = la suppression réelle, qui n'arrive QUE si le flag est ON ET qu'il existe des positions > 395 j (**0 aujourd'hui**).

---

## 🛑 STOP — à valider avant Phase 3 (focus suppression + migration)
1. **Suppression** : dry-run par défaut (`POSITIONS_PURGE_ENABLED=false`), suppression réelle seulement sur flag + après dry-run validé avec toi ; seuil 365+30 j ; lots 10k + borne par run. **OK ?**
2. **Migration** : seul changement = un **index `positions(createdAt)`** (CONCURRENTLY en prod, aucun lock) + une petite table `retention_snapshots`. Aucune colonne/mouvement sur `positions`. Rollback = DROP INDEX. **OK ?**
3. **Durées** : 365 / 30 (défauts), global (per-flotte plus tard). **OK ?**

Dès ton OK → Phase 3 : j'implémente le pipeline **en mode dry-run d'abord**, livré + testé (montre ce qui serait supprimé sans rien effacer), puis les vues. **Aucune suppression réelle sans ton GO après dry-run validé.**
