-- Add new columns to trips table
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "trackerId" UUID;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "fleetId" UUID;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "startLat" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "startLng" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "endLat" DOUBLE PRECISION;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "endLng" DOUBLE PRECISION;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "distanceMeters" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "positionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "segmentationSource" TEXT NOT NULL DEFAULT 'live';

-- Backfill trackerId and fleetId from vehicles
UPDATE "trips" t SET
  "trackerId" = tr."id",
  "fleetId" = v."fleetId",
  "distanceMeters" = t."distanceKm" * 1000
FROM "vehicles" v
LEFT JOIN "trackers" tr ON tr."vehicleId" = v."id"
WHERE t."vehicleId" = v."id" AND t."trackerId" IS NULL;

-- Add index
CREATE INDEX IF NOT EXISTS "trips_fleetId_startedAt_idx" ON "trips"("fleetId", "startedAt" DESC);
