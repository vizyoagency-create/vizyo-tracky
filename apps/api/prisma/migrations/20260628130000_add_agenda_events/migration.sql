-- Sprint 7 — Agenda générique (maintenance + incidents ; fondation Sprint 8 réservations).

-- 1) Nouvelle valeur d'alerte pour les rappels de maintenance (passe par le dispatch existant).
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'MAINTENANCE_DUE';

-- 2) Enums de l'agenda générique.
CREATE TYPE "VehicleEventType" AS ENUM ('MAINTENANCE', 'INCIDENT', 'RESERVATION');
CREATE TYPE "VehicleEventStatus" AS ENUM ('PLANNED', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- 3) Baseline kilométrique autoritaire sur le véhicule (additif, nullable).
ALTER TABLE "vehicles"
  ADD COLUMN "lastOdometerKm" INTEGER,
  ADD COLUMN "lastOdometerAt" TIMESTAMP(3);

-- 4) Plans de maintenance récurrents.
CREATE TABLE "maintenance_plans" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "intervalMonths" INTEGER,
    "intervalKm" INTEGER,
    "lastDoneAt" TIMESTAMP(3),
    "lastDoneKm" INTEGER,
    "reminderDaysBefore" INTEGER NOT NULL DEFAULT 30,
    "reminderKmBefore" INTEGER DEFAULT 1000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "maintenance_plans_fleetId_vehicleId_idx" ON "maintenance_plans"("fleetId", "vehicleId");
CREATE INDEX "maintenance_plans_enabled_idx" ON "maintenance_plans"("enabled");

-- 5) Événements génériques (agenda).
CREATE TABLE "vehicle_events" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "type" "VehicleEventType" NOT NULL,
    "category" TEXT,
    "status" "VehicleEventStatus" NOT NULL DEFAULT 'PLANNED',
    "severity" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT true,
    "odometerKm" INTEGER,
    "planId" UUID,
    "linkedEventId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdBy" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "vehicle_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vehicle_events_fleetId_startAt_idx" ON "vehicle_events"("fleetId", "startAt");
CREATE INDEX "vehicle_events_vehicleId_startAt_idx" ON "vehicle_events"("vehicleId", "startAt" DESC);
CREATE INDEX "vehicle_events_fleetId_type_startAt_idx" ON "vehicle_events"("fleetId", "type", "startAt");
CREATE INDEX "vehicle_events_fleetId_status_idx" ON "vehicle_events"("fleetId", "status");
CREATE INDEX "vehicle_events_planId_idx" ON "vehicle_events"("planId");

-- 6) Clés étrangères (cascade via le véhicule ; plan -> SET NULL pour conserver l'historique).
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_events" ADD CONSTRAINT "vehicle_events_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_events" ADD CONSTRAINT "vehicle_events_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "maintenance_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
