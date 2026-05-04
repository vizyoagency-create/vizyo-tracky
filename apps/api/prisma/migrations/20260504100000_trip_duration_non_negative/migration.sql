-- Sprint corruption-durations : verrouille les invariants chronologiques
-- des trips au niveau base de donnees. Aligne sur les CHECK existants pour
-- distance (cf. migration 20260426130000_trip_distance_non_negative).
--
-- Contexte : 641 trips legacy en prod ont `durationSeconds < 0` a cause d'un
-- bug dans le pipeline live (positions GPS retransmises hors ordre par les
-- trackers en mode store-and-forward, batch ~25 min entrelace avec le live).
-- Le code applicatif est corrige (Fix A: ignore out-of-order ; Fix B: clamp
-- defensif dans finalizeTrip). Cette migration :
--   1. Nettoie les lignes residuelles pour permettre la pose des CHECK.
--   2. Pose les CHECK pour rejeter toute future ecriture incoherente.
--
-- Les trips marques comme corrompus restent visibles (on ne supprime pas)
-- mais avec une duree de 0. Pour restaurer leur vraie duree, lancer le
-- script `scripts/recompute-bad-trips.sh` qui re-segmente depuis la table
-- Position (encore disponible vu la retention ~20j).

-- Etape 1 : clamp duration negative -> 0 et endedAt -> startedAt si reverse.
UPDATE "trips"
SET "durationSeconds" = 0
WHERE "durationSeconds" < 0;

UPDATE "trips"
SET "endedAt" = "startedAt"
WHERE "endedAt" IS NOT NULL AND "endedAt" < "startedAt";

-- Etape 2 : clamp vitesses aberrantes (firmware glitch). Plafond aligne sur
-- TRIP_MAX_PLAUSIBLE_SPEED_KMH = 250 cote applicatif (trips.service.ts) et
-- maxKmh = 250 dans sanitizePositions (gps-sanity.ts).
UPDATE "trips"
SET "maxSpeed" = 0
WHERE "maxSpeed" < 0;
UPDATE "trips"
SET "maxSpeed" = 250
WHERE "maxSpeed" > 250;
UPDATE "trips"
SET "avgSpeed" = 0
WHERE "avgSpeed" < 0;
UPDATE "trips"
SET "avgSpeed" = 250
WHERE "avgSpeed" > 250;

-- Etape 3 : poser les CHECK constraints. Toute future ecriture violant un
-- de ces invariants levera une erreur Prisma plutot que de polluer la base.
ALTER TABLE "trips"
  ADD CONSTRAINT "trips_duration_seconds_non_negative"
    CHECK ("durationSeconds" >= 0),
  ADD CONSTRAINT "trips_ended_at_after_started_at"
    CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
  ADD CONSTRAINT "trips_max_speed_in_range"
    CHECK ("maxSpeed" >= 0 AND "maxSpeed" <= 250),
  ADD CONSTRAINT "trips_avg_speed_in_range"
    CHECK ("avgSpeed" >= 0 AND "avgSpeed" <= 250);
