-- V1.6 — Surveillance Max : module de surveillance renforcee par vehicule.
--
-- 1) Nouveaux enums : SurveillanceMode, SurveillanceSensitivity, trigger, status.
-- 2) Ajout de SURVEILLANCE_TRIGGERED a l'enum AlertType existant.
-- 3) Table surveillance_profiles (1 par vehicule, contient config).
-- 4) Table surveillance_events    (1 par declenchement, audit historique).

-- 1) Nouveaux enums

CREATE TYPE "SurveillanceMode" AS ENUM ('OFF', 'FULL_TIME', 'SCHEDULED');

CREATE TYPE "SurveillanceSensitivity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TYPE "SurveillanceEventTrigger" AS ENUM ('VIBRATION', 'MOVEMENT', 'DOOR');

CREATE TYPE "SurveillanceEventStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'CONFIRMED_THEFT', 'FALSE_ALARM');

-- 2) Etendre AlertType
ALTER TYPE "AlertType" ADD VALUE 'SURVEILLANCE_TRIGGERED';

-- 3) Table surveillance_profiles

CREATE TABLE "surveillance_profiles" (
  "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
  "vehicleId"               UUID NOT NULL,
  "fleetId"                 UUID NOT NULL,
  "mode"                    "SurveillanceMode" NOT NULL DEFAULT 'OFF',
  "sensitivity"             "SurveillanceSensitivity" NOT NULL DEFAULT 'MEDIUM',
  "scheduleStartTime"       TEXT,
  "scheduleEndTime"         TEXT,
  "scheduleDays"            JSONB,
  "triggerVibration"        BOOLEAN NOT NULL DEFAULT true,
  "triggerMovement"         BOOLEAN NOT NULL DEFAULT true,
  "triggerDoor"             BOOLEAN NOT NULL DEFAULT false,
  "additionalNotifyUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "currentlyArmed"          BOOLEAN NOT NULL DEFAULT false,
  "lastArmedAt"             TIMESTAMP(3),
  "lastDisarmedAt"          TIMESTAMP(3),
  "createdBy"               UUID NOT NULL,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "surveillance_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "surveillance_profiles_vehicleId_key" ON "surveillance_profiles"("vehicleId");
CREATE INDEX "surveillance_profiles_fleetId_idx" ON "surveillance_profiles"("fleetId");
CREATE INDEX "surveillance_profiles_mode_currentlyArmed_idx" ON "surveillance_profiles"("mode", "currentlyArmed");

ALTER TABLE "surveillance_profiles"
  ADD CONSTRAINT "surveillance_profiles_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "surveillance_profiles"
  ADD CONSTRAINT "surveillance_profiles_fleetId_fkey"
  FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) Table surveillance_events

CREATE TABLE "surveillance_events" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "profileId"      UUID NOT NULL,
  "vehicleId"     UUID NOT NULL,
  "fleetId"        UUID NOT NULL,
  "alertId"        UUID,
  "trigger"        "SurveillanceEventTrigger" NOT NULL,
  "triggeredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "latitude"       DOUBLE PRECISION,
  "longitude"      DOUBLE PRECISION,
  "speedKmh"       DOUBLE PRECISION,
  "status"         "SurveillanceEventStatus" NOT NULL DEFAULT 'PENDING',
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedBy" UUID,
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "surveillance_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "surveillance_events_alertId_key" ON "surveillance_events"("alertId");
CREATE INDEX "surveillance_events_fleetId_triggeredAt_idx" ON "surveillance_events"("fleetId", "triggeredAt" DESC);
CREATE INDEX "surveillance_events_vehicleId_triggeredAt_idx" ON "surveillance_events"("vehicleId", "triggeredAt" DESC);
CREATE INDEX "surveillance_events_status_idx" ON "surveillance_events"("status");

ALTER TABLE "surveillance_events"
  ADD CONSTRAINT "surveillance_events_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "surveillance_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "surveillance_events"
  ADD CONSTRAINT "surveillance_events_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "surveillance_events"
  ADD CONSTRAINT "surveillance_events_fleetId_fkey"
  FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "surveillance_events"
  ADD CONSTRAINT "surveillance_events_alertId_fkey"
  FOREIGN KEY ("alertId") REFERENCES "alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
