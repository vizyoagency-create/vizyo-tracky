-- Incr. RGPD calendrier — cadre de temps de travail par vehicule (usage mixte).
-- Hors des plages declarees = mode prive automatique (positions non collectees a l'ingestion).
-- `workOverrideUntil` sur le vehicule = exception ponctuelle « je travaille » (conducteur).

-- AlterTable Vehicle : exception ponctuelle de suivi (dimanche travaille, etc.).
ALTER TABLE "vehicles" ADD COLUMN "workOverrideUntil" TIMESTAMP(3);

-- CreateTable : cadre de temps de travail (1 par vehicule, opt-in).
CREATE TABLE "vehicle_work_schedules" (
    "id" UUID NOT NULL,
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
    "mondaySlots" JSONB,
    "tuesdaySlots" JSONB,
    "wednesdaySlots" JSONB,
    "thursdaySlots" JSONB,
    "fridaySlots" JSONB,
    "saturdaySlots" JSONB,
    "sundaySlots" JSONB,
    "countryCode" TEXT NOT NULL DEFAULT 'FR',
    "customDates" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_work_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex : 1 cadre par vehicule.
CREATE UNIQUE INDEX "vehicle_work_schedules_vehicleId_key" ON "vehicle_work_schedules"("vehicleId");

-- AddForeignKey
ALTER TABLE "vehicle_work_schedules" ADD CONSTRAINT "vehicle_work_schedules_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
