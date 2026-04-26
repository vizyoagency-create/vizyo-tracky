-- V1.5 (Sprint N) — Geofences V2 : corridors + import GeoJSON + ciblage par vehicule.
--
-- 1) GeofenceType etendu avec CORRIDOR (geofence lineaire avec largeur).
-- 2) Geofence.corridorPoints / corridorWidthM pour les corridors.
-- 3) geofence_vehicles : ciblage explicite (vide = applique a tous = compat V1).

-- 1) Etendre l'enum (Postgres : ALTER TYPE ... ADD VALUE)
ALTER TYPE "GeofenceType" ADD VALUE IF NOT EXISTS 'CORRIDOR';

-- 2) Champs corridor sur Geofence
ALTER TABLE "geofences"
  ADD COLUMN "corridorPoints" JSONB,
  ADD COLUMN "corridorWidthM" INTEGER DEFAULT 100;

-- 3) Table geofence_vehicles (ciblage)
CREATE TABLE "geofence_vehicles" (
  "geofenceId" UUID NOT NULL,
  "vehicleId"  UUID NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "geofence_vehicles_pkey" PRIMARY KEY ("geofenceId", "vehicleId")
);

CREATE INDEX "geofence_vehicles_vehicleId_idx" ON "geofence_vehicles"("vehicleId");

ALTER TABLE "geofence_vehicles"
  ADD CONSTRAINT "geofence_vehicles_geofenceId_fkey"
  FOREIGN KEY ("geofenceId") REFERENCES "geofences"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
