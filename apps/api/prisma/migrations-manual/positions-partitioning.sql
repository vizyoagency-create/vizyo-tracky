-- V1.10 (Sprint 6 scaling) — Partitionnement RANGE de la table positions.
--
-- ⚠️ NE PAS LANCER VIA `prisma migrate` ⚠️
-- Cette migration n'est PAS dans le dossier `migrations/` automatique : elle
-- doit etre executee manuellement par un DBA en respectant la procedure
-- documentee dans `docs/20-position-partitioning-plan.md`.
--
-- POURQUOI : a 100 vehicules × 1 position/10s adaptive ~= 864k rows/jour.
-- Sur 1 an : ~315M rows. Sans partitionnement, les SELECT history sur une
-- fenetre de 7j passent de 50ms (small table) a 5-10s (lookup dans 315M).
-- Avec PARTITION BY RANGE (timestamp), Postgres prune automatiquement les
-- partitions hors fenetre — chaque query ne touche que ~5M rows / mois.
--
-- PROCEDURE PROD (resume — voir doc complete) :
--   1. Annonce maintenance ~30min (selon volume).
--   2. STOP les ingestions TCP (docker stop tracky-api).
--   3. pg_dump table positions pour fallback.
--   4. Run ce script.
--   5. Recreer FK / RLS si applicables.
--   6. RESTART api, verifier que les INSERT batchent bien dans la bonne partition.
--   7. Si OK pendant 24h, DROP positions_old.
--
-- ALTERNATIVE LOW-DOWNTIME : utiliser `pg_partman` extension qui supporte
-- la migration progressive sans freeze. Plus complexe a setup mais 0 downtime.
-- Cf. doc pour le choix entre les 2 strategies.

BEGIN;

-- ── Etape 1 : nouvelle table partitionnee, meme schema ──────────────────
CREATE TABLE "positions_new" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "trackerId"   UUID NOT NULL,
  "lat"         DOUBLE PRECISION NOT NULL,
  "lng"         DOUBLE PRECISION NOT NULL,
  "speedKmh"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "heading"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "altitude"    DOUBLE PRECISION,
  "satellites"  INTEGER,
  "valid"       BOOLEAN NOT NULL DEFAULT true,
  "ignition"    BOOLEAN,
  "timestamp"   TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id", "timestamp")  -- partitioning column doit etre dans la PK
) PARTITION BY RANGE ("timestamp");

-- ── Etape 2 : partitions mensuelles glissantes ──────────────────────────
-- Bootstrap des partitions des 13 derniers mois + 3 mois futurs (buffer).
-- En prod, automatiser via cron + pg_partman pour creer les partitions du
-- mois suivant (sinon les INSERT dans une partition manquante throw).
DO $$
DECLARE
  start_month DATE := date_trunc('month', NOW() - INTERVAL '12 months')::date;
  end_month   DATE := date_trunc('month', NOW() + INTERVAL '3 months')::date;
  cur DATE;
  next_cur DATE;
  partition_name TEXT;
BEGIN
  cur := start_month;
  WHILE cur < end_month LOOP
    next_cur := cur + INTERVAL '1 month';
    partition_name := 'positions_' || to_char(cur, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF positions_new FOR VALUES FROM (%L) TO (%L)',
      partition_name, cur, next_cur
    );
    cur := next_cur;
  END LOOP;
END $$;

-- ── Etape 3 : indexes (heritage des partitions) ─────────────────────────
-- L'index sur la table parent se propage automatiquement aux partitions.
CREATE INDEX ON "positions_new" ("trackerId", "timestamp" DESC);

-- ── Etape 4 : copie des donnees ─────────────────────────────────────────
-- ⚠️ Cette etape peut prendre des minutes (proportionnel a la taille de la
-- table source). En prod, planifier la maintenance.
INSERT INTO "positions_new" (
  "id", "trackerId", "lat", "lng", "speedKmh", "heading", "altitude",
  "satellites", "valid", "ignition", "timestamp", "createdAt"
)
SELECT
  "id", "trackerId", "lat", "lng", "speedKmh", "heading", "altitude",
  "satellites", "valid", "ignition", "timestamp", "createdAt"
FROM "positions";

-- ── Etape 5 : swap ──────────────────────────────────────────────────────
ALTER TABLE "positions" RENAME TO "positions_old";
ALTER TABLE "positions_new" RENAME TO "positions";

-- Recreer la FK trackerId -> trackers(id). La FK ne se cree pas
-- automatiquement sur table partitionnee (limitation Postgres < 17).
ALTER TABLE "positions"
  ADD CONSTRAINT "positions_trackerId_fkey"
  FOREIGN KEY ("trackerId") REFERENCES "trackers"("id") ON DELETE CASCADE;

COMMIT;

-- ── Etape 6 (apres validation 24h prod) ─────────────────────────────────
-- DROP TABLE "positions_old";
--
-- ── Automatisation cron (a setup separement) ────────────────────────────
-- Cron mensuel pour creer la partition du mois suivant + drop la partition
-- de retention (~ M-13 si retention 12 mois).
-- Recommande : pg_partman + pg_cron, ou un script shell + psql lance par
-- systemd timer sur le VPS Postgres.
