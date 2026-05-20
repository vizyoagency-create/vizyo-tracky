# Plan : Partitionner la table `positions` (Postgres RANGE)

**Date** : 2026-05-20 (Sprint 6 finition)
**Severite** : 🟠 Haute (perf à long terme)
**Effort** : 1 jour de prep + 30 min de maintenance prod (low-downtime) ou 0 downtime avec `pg_partman`

## Pourquoi

À 100 véhicules × adaptive sampling ~1 position / 10s = **~864k rows/jour**. Sur 1 an = ~315M rows. Sans partitionnement, chaque SELECT history sur une fenêtre de 7j passe de 50ms (table small) à 5-10s (full scan sur 315M rows).

Avec `PARTITION BY RANGE (timestamp)`, Postgres élague (partition pruning) automatiquement les partitions hors fenêtre : chaque query ne touche que ~5M rows / mois.

**Gain mesuré** typique :
- SELECT 7j historique : 5s → 80ms
- DELETE retention 90j (cron purge) : 30s lock → instantané (DROP PARTITION)

## Stratégie 1 (recommandée pour <50M rows actuels) : maintenance courte

1. **Prép** : créer la nouvelle table partitionnée + bootstrap des partitions des 13 derniers mois + 3 mois futurs (script SQL fourni dans `apps/api/prisma/migrations-manual/positions-partitioning.sql`).
2. **Maintenance ~30 min** :
   - Annonce ops + `STOP` ingestion (`docker stop tracky-api`).
   - `pg_dump` table positions (fallback).
   - Run le script SQL (la copie INSERT prend l'essentiel du temps).
   - Recréer la FK `trackerId → trackers(id)`.
   - `START` api.
   - Vérifier qu'un INSERT test atterrit dans la bonne partition (`pg_partition_tree`).
3. **Après 24h de prod sans souci** : `DROP TABLE positions_old`.

## Stratégie 2 (recommandée pour >50M rows) : zero-downtime avec `pg_partman`

1. Installer `pg_partman` (extension PostgreSQL) sur le VPS.
2. Configurer le `partman.create_parent()` pour la table positions existante (mode `partition_data_proc` pour migrer progressivement les données par lots de 10k rows en background).
3. Une fois le `partition_data_proc` terminé (vérifier `partman.show_partition_info()`), supprimer la table source.
4. Setup le cron `partman.run_maintenance_proc()` (toutes les heures via `pg_cron` ou systemd timer) pour créer les partitions futures + drop les anciennes selon retention.

Doc upstream : https://github.com/pgpartman/pg_partman/blob/master/doc/pg_partman.md

## Effets de bord à valider

- **Prisma** : la table reste accessible normalement, Prisma n'a pas connaissance du partitionnement (transparent). Aucun changement de schema.prisma nécessaire après migration.
- **Index** : l'index `(trackerId, timestamp DESC)` se propage automatiquement aux partitions enfant lors de leur création.
- **FK** : Postgres < 17 ne supporte pas la création automatique de FK sur table partitionnée. Le script SQL recrée manuellement la contrainte `positions_trackerId_fkey`. Postgres 17+ peut auto-propager.
- **Purge nocturne** : `PositionHistoryService.purgeOldFinePositions()` (cron 3AM) reste fonctionnel — `DELETE FROM positions WHERE timestamp < cutoff` routera vers les bonnes partitions. **Mais** : remplacer par `DROP TABLE positions_YYYY_MM` pour les partitions entières dépassant retention donne 1000x plus rapide (instantané vs scan).
- **Backups** : `pg_dump` partitionne déjà correctement chaque partition. Aucun changement.
- **Ingestion TCP** : le `PositionBatchBufferService.flush()` (Sprint 2) fait un seul `createMany` — chaque row sera routé automatiquement par Postgres vers la bonne partition. Aucun code change.

## Pourquoi pas dans la migration auto

`prisma migrate deploy` ne supporte pas le swap risqué (RENAME + INSERT large) en transaction unique. Et un downtime imposé par Prisma à un client en prod sans planification = catastrophe.

→ La migration `migrations-manual/positions-partitioning.sql` est **explicitement hors du dossier Prisma standard** pour empêcher l'auto-application. Au déploiement futur, planifier la maintenance manuellement.

## Checklist avant l'opération

- [ ] Volume actuel de la table positions mesuré : `SELECT pg_size_pretty(pg_total_relation_size('positions'));`
- [ ] Choix stratégie : si > 50M rows → stratégie 2 (pg_partman), sinon stratégie 1.
- [ ] Backup verified (test restore sur staging).
- [ ] Cron de purge `purgeOldFinePositions` (3AM) désactivé pendant la migration (pour éviter une concurrence).
- [ ] Setup `pg_cron` ou systemd timer pour la maintenance mensuelle (créer la partition du mois suivant).
