-- V1.5 (Sprint H3) — Pilotage adaptatif du fix interval boitier (Coban `fix...***n`)
-- + observabilite admin enrichie sur les commandes tracker.
--
-- Trois changements :
--   1) Feature flag par fleet (opt-out pour contrats imposant fix030s permanent).
--   2) Etat fix mode sur tracker (desired/current/syncAt + compteur echecs + override).
--   3) Champs d'observabilite sur tracker_commands (snapshot contextuel au moment
--      de l'envoi, diagnostic hint, acknowledgment admin, observed result).

-- 1) Feature flag fleet
ALTER TABLE "fleets"
  ADD COLUMN "adaptiveFixModeEnabled" BOOLEAN NOT NULL DEFAULT true;

-- 2) Etat fix mode sur tracker
ALTER TABLE "trackers"
  ADD COLUMN "desiredFixIntervalS"    INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "currentFixIntervalS"    INTEGER,
  ADD COLUMN "lastFixIntervalSyncAt"  TIMESTAMP(3),
  ADD COLUMN "fixCommandFailureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fixCommandFailing"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fixModeOverrideUntil"   TIMESTAMP(3),
  ADD COLUMN "lastValidFrameAt"       TIMESTAMP(3);

-- Backfill : initialiser lastValidFrameAt avec lastPositionAt pour eviter de
-- considerer les trackers existants comme "stale" au premier reconcile.
UPDATE "trackers"
SET "lastValidFrameAt" = "lastPositionAt"
WHERE "lastPositionAt" IS NOT NULL;

-- 3) Observabilite tracker_commands
ALTER TABLE "tracker_commands"
  ADD COLUMN "expectedResult"   TEXT,
  ADD COLUMN "observedResult"   TEXT,
  ADD COLUMN "contextSnapshot"  JSONB,
  ADD COLUMN "diagnosticHint"   TEXT,
  ADD COLUMN "outcomeReason"    TEXT,
  ADD COLUMN "acknowledgedBy"   UUID,
  ADD COLUMN "acknowledgedAt"   TIMESTAMP(3);

CREATE INDEX "tracker_commands_category_status_idx"
  ON "tracker_commands" ("category", "status");

-- Index partiel pour les FAILING (centre d'alertes admin /admin/alerts)
CREATE INDEX "trackers_failing_idx"
  ON "trackers" ("fixCommandFailing")
  WHERE "fixCommandFailing" = true;
