-- AlterTable: Add ignition tracking to positions
ALTER TABLE "positions" ADD COLUMN "ignition" BOOLEAN;

-- AlterTable: Add last known ignition state to trackers
ALTER TABLE "trackers" ADD COLUMN "lastKnownIgnition" BOOLEAN;
ALTER TABLE "trackers" ADD COLUMN "lastIgnitionChangeAt" TIMESTAMPTZ;
