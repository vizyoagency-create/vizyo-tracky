-- CreateEnum
CREATE TYPE "MissionStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'LATE', 'DONE', 'CANCELLED');
-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'DEPOT';
-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "missionId" UUID;
-- CreateTable
CREATE TABLE "missions" (
    "id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "fleetId" UUID NOT NULL,
    "originPlaceId" UUID,
    "originLabel" TEXT NOT NULL,
    "destPlaceId" UUID,
    "destLabel" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID,
    "depotUserId" UUID,
    "status" "MissionStatus" NOT NULL DEFAULT 'PLANNED',
    "actualStartAt" TIMESTAMP(3),
    "actualEndAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdByUserId" UUID,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "missions_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "missions_fleetId_startAt_idx" ON "missions"("fleetId", "startAt");
-- CreateIndex
CREATE INDEX "missions_depotUserId_startAt_idx" ON "missions"("depotUserId", "startAt");
-- CreateIndex
CREATE INDEX "missions_vehicleId_startAt_endAt_idx" ON "missions"("vehicleId", "startAt", "endAt");
-- CreateIndex
CREATE UNIQUE INDEX "missions_fleetId_ref_key" ON "missions"("fleetId", "ref");
-- CreateIndex
CREATE INDEX "trips_missionId_idx" ON "trips"("missionId");
-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "missions" ADD CONSTRAINT "missions_depotUserId_fkey" FOREIGN KEY ("depotUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
