-- AlterEnum: replace AlertType values
ALTER TYPE "AlertType" RENAME TO "AlertType_old";
CREATE TYPE "AlertType" AS ENUM ('SOS', 'POWER_CUT', 'ACCIDENT', 'COLLISION', 'LOW_BATTERY', 'OVERSPEED', 'GEOFENCE_EXIT', 'MOVEMENT_IDLE', 'HARSH_BRAKING', 'HARSH_ACCELERATION', 'HARSH_TURN', 'BONNET', 'DOOR', 'VIBRATION', 'UNKNOWN');

-- Migrate existing data (map old values to new)
ALTER TABLE "alerts" ALTER COLUMN "type" TYPE "AlertType" USING (
  CASE "type"::text
    WHEN 'SPEEDING' THEN 'OVERSPEED'
    WHEN 'GEOFENCE_ENTER' THEN 'GEOFENCE_EXIT'
    WHEN 'OFFLINE' THEN 'UNKNOWN'
    ELSE "type"::text
  END
)::"AlertType";
DROP TYPE "AlertType_old";

-- AlterTable: alerts - make vehicleId optional, add new columns
ALTER TABLE "alerts" ALTER COLUMN "vehicleId" DROP NOT NULL;
ALTER TABLE "alerts" ALTER COLUMN "message" DROP NOT NULL;
ALTER TABLE "alerts" ADD COLUMN "fleetId" UUID;
ALTER TABLE "alerts" ADD COLUMN "trackerId" UUID;
ALTER TABLE "alerts" ADD COLUMN "title" TEXT NOT NULL DEFAULT 'Alerte';
ALTER TABLE "alerts" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "alerts" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "alerts" ALTER COLUMN "payload" DROP NOT NULL;
ALTER TABLE "alerts" ALTER COLUMN "payload" DROP DEFAULT;

-- Backfill fleetId from vehicle
UPDATE "alerts" SET "fleetId" = v."fleetId" FROM "vehicles" v WHERE "alerts"."vehicleId" = v."id";

-- Make fleetId required after backfill
ALTER TABLE "alerts" ALTER COLUMN "fleetId" SET NOT NULL;

-- Remove old default on title
ALTER TABLE "alerts" ALTER COLUMN "title" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "trackers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledgedBy_fkey" FOREIGN KEY ("acknowledgedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropForeignKey (old cascade, replace with set null)
ALTER TABLE "alerts" DROP CONSTRAINT IF EXISTS "alerts_vehicleId_fkey";
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
DROP INDEX IF EXISTS "alerts_vehicleId_createdAt_idx";
DROP INDEX IF EXISTS "alerts_acknowledgedAt_idx";
CREATE INDEX "alerts_fleetId_createdAt_idx" ON "alerts"("fleetId", "createdAt" DESC);
CREATE INDEX "alerts_fleetId_acknowledgedAt_idx" ON "alerts"("fleetId", "acknowledgedAt");
CREATE INDEX "alerts_vehicleId_idx" ON "alerts"("vehicleId");
CREATE INDEX "alerts_trackerId_idx" ON "alerts"("trackerId");
