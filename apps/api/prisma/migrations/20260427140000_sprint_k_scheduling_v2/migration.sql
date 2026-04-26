-- V1.5 (Sprint K) — Scheduling horaire V2.
--
-- 1) Multi-plages par jour (mondaySlots, tuesdaySlots, ...) : JSONB array
--    de {start, end}. Si null, fallback sur les colonnes legacy mondayStart/End.
-- 2) Pays jours feries (`countryCode`, default 'FR' — lib `date-holidays`).
-- 3) Override ponctuel par date (`customDates` JSONB) — priorite max.
-- 4) Table `schedule_history` pour la timeline UI + audit.

ALTER TABLE "vehicle_schedules"
  ADD COLUMN "mondaySlots"    JSONB,
  ADD COLUMN "tuesdaySlots"   JSONB,
  ADD COLUMN "wednesdaySlots" JSONB,
  ADD COLUMN "thursdaySlots"  JSONB,
  ADD COLUMN "fridaySlots"    JSONB,
  ADD COLUMN "saturdaySlots"  JSONB,
  ADD COLUMN "sundaySlots"    JSONB,
  ADD COLUMN "countryCode"    TEXT NOT NULL DEFAULT 'FR',
  ADD COLUMN "customDates"    JSONB;

CREATE TABLE "schedule_history" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "scheduleId" UUID NOT NULL,
  "vehicleId"  UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "action"     TEXT NOT NULL,
  "reason"     TEXT NOT NULL,
  "windowDesc" TEXT,

  CONSTRAINT "schedule_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "schedule_history_scheduleId_occurredAt_idx" ON "schedule_history" ("scheduleId", "occurredAt" DESC);
CREATE INDEX "schedule_history_vehicleId_occurredAt_idx" ON "schedule_history" ("vehicleId", "occurredAt" DESC);

ALTER TABLE "schedule_history"
  ADD CONSTRAINT "schedule_history_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "vehicle_schedules" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
