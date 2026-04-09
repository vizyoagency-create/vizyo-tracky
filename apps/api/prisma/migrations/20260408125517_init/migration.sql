-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'FLEET_ADMIN', 'FLEET_MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "TrackerStatus" AS ENUM ('ONLINE', 'OFFLINE', 'IDLE');

-- CreateEnum
CREATE TYPE "GeofenceType" AS ENUM ('CIRCLE', 'POLYGON');

-- CreateEnum
CREATE TYPE "GeofenceRule" AS ENUM ('ENTER', 'EXIT', 'BOTH');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('SPEEDING', 'LOW_BATTERY', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT', 'SOS', 'OFFLINE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EngineAction" AS ENUM ('CUT', 'RESTORE');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'REJECTED_SPEED');

-- CreateTable
CREATE TABLE "fleets" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "fleetId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trackers" (
    "id" UUID NOT NULL,
    "imei" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'COBAN_GPS403D',
    "status" "TrackerStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastSeenAt" TIMESTAMP(3),
    "vehicleId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trackers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "trackerId" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "heading" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "altitude" DOUBLE PRECISION,
    "satellites" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "distanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxSpeed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgSpeed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "polyline" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geofences" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "GeofenceType" NOT NULL,
    "rule" "GeofenceRule" NOT NULL DEFAULT 'BOTH',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geofences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_control_commands" (
    "id" UUID NOT NULL,
    "trackerId" UUID NOT NULL,
    "action" "EngineAction" NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "requestedBy" UUID NOT NULL,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engine_control_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_fleetId_idx" ON "users"("fleetId");

-- CreateIndex
CREATE INDEX "vehicles_fleetId_idx" ON "vehicles"("fleetId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_fleetId_plate_key" ON "vehicles"("fleetId", "plate");

-- CreateIndex
CREATE UNIQUE INDEX "trackers_imei_key" ON "trackers"("imei");

-- CreateIndex
CREATE UNIQUE INDEX "trackers_vehicleId_key" ON "trackers"("vehicleId");

-- CreateIndex
CREATE INDEX "trackers_status_idx" ON "trackers"("status");

-- CreateIndex
CREATE INDEX "positions_trackerId_timestamp_idx" ON "positions"("trackerId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "trips_vehicleId_startedAt_idx" ON "trips"("vehicleId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "geofences_fleetId_idx" ON "geofences"("fleetId");

-- CreateIndex
CREATE INDEX "alerts_vehicleId_createdAt_idx" ON "alerts"("vehicleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "alerts_acknowledgedAt_idx" ON "alerts"("acknowledgedAt");

-- CreateIndex
CREATE INDEX "engine_control_commands_trackerId_status_idx" ON "engine_control_commands"("trackerId", "status");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trackers" ADD CONSTRAINT "trackers_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "trackers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_control_commands" ADD CONSTRAINT "engine_control_commands_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "trackers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PostGIS columns
ALTER TABLE "positions" ADD COLUMN "location" geography(Point, 4326);
CREATE INDEX "positions_location_gix" ON "positions" USING GIST ("location");
ALTER TABLE "geofences" ADD COLUMN "geometry" geography(Geometry, 4326) NOT NULL DEFAULT ST_GeogFromText('POINT(0 0)');
CREATE INDEX "geofences_geometry_gix" ON "geofences" USING GIST ("geometry");
