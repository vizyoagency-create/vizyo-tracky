-- Zones mortes GPS (2026-07) — suivi de l'incident FS-253.
-- Detecte qu'un vehicule perd RECURREMMENT son lock GPS au MEME endroit (parking souterrain/
-- couvert, tunnel, ou brouilleur) plutot qu'une panne d'antenne ponctuelle. L'ancre de
-- clustering est la derniere position VALIDE avant la perte (figee cote trackers.lastLat/lastLng).

-- CreateEnum
CREATE TYPE "GpsDeadZoneStatus" AS ENUM ('LEARNING', 'RECURRING', 'CONFIRMED_BENIGN', 'SUSPECT');

-- CreateEnum
CREATE TYPE "GpsDeadZoneLabel" AS ENUM ('UNKNOWN', 'UNDERGROUND_PARKING', 'COVERED_PARKING', 'TUNNEL', 'JAMMER_SUSPECTED', 'OTHER');

-- CreateTable : zone morte agregee (1 cluster = 1 endroit ou le vehicule perd le GPS).
CREATE TABLE "gps_dead_zones" (
    "id" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "centroidLat" DOUBLE PRECISION NOT NULL,
    "centroidLng" DOUBLE PRECISION NOT NULL,
    "radiusM" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "GpsDeadZoneStatus" NOT NULL DEFAULT 'LEARNING',
    "label" "GpsDeadZoneLabel" NOT NULL DEFAULT 'UNKNOWN',
    "placeLabel" TEXT,
    "note" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gps_dead_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable : episode de perte GPS. (vehicleId, lostAt) unique = 1 episode = 1 ligne (idempotence).
CREATE TABLE "gps_loss_events" (
    "id" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "trackerId" UUID,
    "zoneId" UUID,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "lostAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gps_loss_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gps_dead_zones_vehicleId_idx" ON "gps_dead_zones"("vehicleId");

-- CreateIndex
CREATE INDEX "gps_dead_zones_fleetId_idx" ON "gps_dead_zones"("fleetId");

-- CreateIndex
CREATE INDEX "gps_loss_events_zoneId_idx" ON "gps_loss_events"("zoneId");

-- CreateIndex
CREATE INDEX "gps_loss_events_fleetId_detectedAt_idx" ON "gps_loss_events"("fleetId", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "gps_loss_events_vehicleId_lostAt_key" ON "gps_loss_events"("vehicleId", "lostAt");

-- AddForeignKey
ALTER TABLE "gps_dead_zones" ADD CONSTRAINT "gps_dead_zones_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_loss_events" ADD CONSTRAINT "gps_loss_events_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_loss_events" ADD CONSTRAINT "gps_loss_events_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "gps_dead_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
