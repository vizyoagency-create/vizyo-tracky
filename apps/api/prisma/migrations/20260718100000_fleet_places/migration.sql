-- Lieux cles (2026-07) — referentiel METIER des lieux de la flotte : stations-service VALIDEES
-- par l'exploitant, parkings & stationnements recurrents crees a la main (ex. « CDEF Launaguet »),
-- depots. Pilote la couleur carte (station validee vs simplement detectee).
-- fleetId / stationId / createdById sont denormalises (pas de FK) — meme convention que
-- gps_dead_zones / trip_fuel_stops : evite d'alourdir les modeles Fleet/FuelStation.

-- CreateEnum
CREATE TYPE "FleetPlaceKind" AS ENUM ('FUEL_STATION', 'PARKING', 'DEPOT', 'OTHER');

-- CreateTable
CREATE TABLE "fleet_places" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FleetPlaceKind" NOT NULL DEFAULT 'OTHER',
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusM" DOUBLE PRECISION NOT NULL DEFAULT 120,
    "note" TEXT,
    "stationId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_places_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fleet_places_fleetId_idx" ON "fleet_places"("fleetId");

-- CreateIndex
CREATE INDEX "fleet_places_fleetId_kind_idx" ON "fleet_places"("fleetId", "kind");

-- CreateIndex : une station ne peut etre validee qu'UNE fois par flotte. Les parkings ont
-- stationId NULL et Postgres autorise plusieurs NULL dans un index unique -> pas de blocage.
CREATE UNIQUE INDEX "fleet_places_fleetId_stationId_key" ON "fleet_places"("fleetId", "stationId");
