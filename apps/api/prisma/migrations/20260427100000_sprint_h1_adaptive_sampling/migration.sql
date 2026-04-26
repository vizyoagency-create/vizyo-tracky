-- V1.5 (Sprint H1) — Sampling adaptatif des positions cote serveur.
-- Objectif : reduire de 60-80% le volume des INSERT dans `positions` pour les
-- vehicules a l'arret, sans degrader l'UX live (le broadcast WS reste integral).
--
-- Trois changements :
--   1) Feature flag par fleet (opt-out pour contrats imposant un tracage continu).
--   2) Etat du sampling sur chaque tracker (lastWriteAt, lastSampledState, verboseUntil).
--   3) Audit trail rolling 7j (table `position_sampling_decisions`).

-- 1) Feature flag fleet
ALTER TABLE "fleets"
  ADD COLUMN "adaptiveSamplingEnabled" BOOLEAN NOT NULL DEFAULT true;

-- 2) Etat sampling sur tracker
ALTER TABLE "trackers"
  ADD COLUMN "lastWriteAt"      TIMESTAMP(3),
  ADD COLUMN "lastSampledState" TEXT,
  ADD COLUMN "verboseUntil"     TIMESTAMP(3);

-- Backfill : pour chaque tracker, initialiser lastWriteAt avec lastPositionAt
-- afin que le premier passage post-deploiement ne soit pas considere comme stale.
UPDATE "trackers"
SET "lastWriteAt" = "lastPositionAt"
WHERE "lastPositionAt" IS NOT NULL;

-- 3) Table audit sampling
CREATE TABLE "position_sampling_decisions" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "trackerId"  UUID NOT NULL,
  "decision"   TEXT NOT NULL,
  "state"      TEXT NOT NULL,
  "reason"     TEXT,
  "speedKmh"   DOUBLE PRECISION,
  "ignition"   BOOLEAN,
  "distanceM"  DOUBLE PRECISION,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "position_sampling_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "position_sampling_decisions_trackerId_receivedAt_idx"
  ON "position_sampling_decisions" ("trackerId", "receivedAt" DESC);

CREATE INDEX "position_sampling_decisions_receivedAt_idx"
  ON "position_sampling_decisions" ("receivedAt");

ALTER TABLE "position_sampling_decisions"
  ADD CONSTRAINT "position_sampling_decisions_trackerId_fkey"
  FOREIGN KEY ("trackerId") REFERENCES "trackers" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
