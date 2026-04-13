-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('CAR', 'TRUCK', 'VAN', 'MOTORCYCLE', 'BICYCLE', 'BUS', 'CONSTRUCTION', 'OTHER');

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "type" "VehicleType" NOT NULL DEFAULT 'CAR';
