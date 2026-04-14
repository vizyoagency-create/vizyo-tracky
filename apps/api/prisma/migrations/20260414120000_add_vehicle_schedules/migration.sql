-- AlterTable: add source column to engine_control_commands
ALTER TABLE "engine_control_commands" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';

-- CreateTable: vehicle_schedules
CREATE TABLE "vehicle_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicleId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "mondayEnabled" BOOLEAN NOT NULL DEFAULT true,
    "mondayStart" TEXT,
    "mondayEnd" TEXT,
    "tuesdayEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tuesdayStart" TEXT,
    "tuesdayEnd" TEXT,
    "wednesdayEnabled" BOOLEAN NOT NULL DEFAULT true,
    "wednesdayStart" TEXT,
    "wednesdayEnd" TEXT,
    "thursdayEnabled" BOOLEAN NOT NULL DEFAULT true,
    "thursdayStart" TEXT,
    "thursdayEnd" TEXT,
    "fridayEnabled" BOOLEAN NOT NULL DEFAULT true,
    "fridayStart" TEXT,
    "fridayEnd" TEXT,
    "saturdayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "saturdayStart" TEXT,
    "saturdayEnd" TEXT,
    "sundayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sundayStart" TEXT,
    "sundayEnd" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastEvaluatedState" TEXT,
    "overrideUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_schedules_vehicleId_key" ON "vehicle_schedules"("vehicleId");

-- AddForeignKey
ALTER TABLE "vehicle_schedules" ADD CONSTRAINT "vehicle_schedules_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
