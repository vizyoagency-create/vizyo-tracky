/*
  Warnings:

  - You are about to drop the column `geometry` on the `geofences` table. All the data in the column will be lost.
  - You are about to drop the column `location` on the `positions` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "geofences_geometry_gix";

-- DropIndex
DROP INDEX "positions_location_gix";

-- AlterTable
ALTER TABLE "geofences" DROP COLUMN "geometry";

-- AlterTable
ALTER TABLE "positions" DROP COLUMN "location",
ADD COLUMN     "valid" BOOLEAN NOT NULL DEFAULT true;
