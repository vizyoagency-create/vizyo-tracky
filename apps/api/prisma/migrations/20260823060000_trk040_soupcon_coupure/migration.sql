-- AlterTable
ALTER TABLE "trackers" ADD COLUMN     "lastBatteryAt" TIMESTAMP(3),
ADD COLUMN     "lastBatteryPercent" INTEGER,
ADD COLUMN     "powerLossSuspectAt" TIMESTAMP(3),
ADD COLUMN     "powerLossSuspectBattery" INTEGER;

