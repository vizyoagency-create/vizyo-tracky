/*
  Warnings:

  - You are about to drop the column `geometry` on the `geofences` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('ALL', 'GROUP', 'VEHICLE');

-- DropIndex
DROP INDEX "geofences_geometry_gix";

-- AlterTable
ALTER TABLE "geofences" DROP COLUMN "geometry";

-- CreateTable
CREATE TABLE "vehicle_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "fleetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_group_assignments" (
    "vehicleId" UUID NOT NULL,
    "groupId" UUID NOT NULL,

    CONSTRAINT "vehicle_group_assignments_pkey" PRIMARY KEY ("vehicleId","groupId")
);

-- CreateTable
CREATE TABLE "user_vehicle_access" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accessType" "AccessType" NOT NULL,
    "groupId" UUID,
    "vehicleId" UUID,

    CONSTRAINT "user_vehicle_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_groups_fleetId_idx" ON "vehicle_groups"("fleetId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_groups_fleetId_name_key" ON "vehicle_groups"("fleetId", "name");

-- CreateIndex
CREATE INDEX "user_vehicle_access_userId_idx" ON "user_vehicle_access"("userId");

-- AddForeignKey
ALTER TABLE "vehicle_groups" ADD CONSTRAINT "vehicle_groups_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_group_assignments" ADD CONSTRAINT "vehicle_group_assignments_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_group_assignments" ADD CONSTRAINT "vehicle_group_assignments_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "vehicle_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_vehicle_access" ADD CONSTRAINT "user_vehicle_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_vehicle_access" ADD CONSTRAINT "user_vehicle_access_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "vehicle_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_vehicle_access" ADD CONSTRAINT "user_vehicle_access_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
