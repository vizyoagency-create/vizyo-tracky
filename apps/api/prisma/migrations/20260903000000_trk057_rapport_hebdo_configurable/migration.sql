-- Rapport hebdomadaire (2026-09) — réglage PAR SOCIÉTÉ + journal des envois.
-- Écrite à la main (la base locale a une dérive de défauts qui empêche `migrate dev`) ;
-- même forme que ce que Prisma aurait produit. Appliquée par `migrate deploy` (entrypoint).

-- CreateTable
CREATE TABLE "fleet_report_schedules" (
    "fleetId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weekday" INTEGER NOT NULL DEFAULT 1,
    "hour" INTEGER NOT NULL DEFAULT 8,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sections" TEXT[] DEFAULT ARRAY['kpi', 'alerts', 'topVehicles', 'trips']::TEXT[],
    "vehicleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxTrips" INTEGER NOT NULL DEFAULT 30,
    "topN" INTEGER NOT NULL DEFAULT 10,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" UUID,

    CONSTRAINT "fleet_report_schedules_pkey" PRIMARY KEY ("fleetId")
);

-- CreateTable
CREATE TABLE "fleet_report_dispatches" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tripsCount" INTEGER NOT NULL DEFAULT 0,
    "pdfBytes" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "requestedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_report_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fleet_report_dispatches_fleetId_createdAt_idx" ON "fleet_report_dispatches"("fleetId", "createdAt");

-- CreateIndex
CREATE INDEX "fleet_report_dispatches_createdAt_idx" ON "fleet_report_dispatches"("createdAt");

-- AddForeignKey
ALTER TABLE "fleet_report_schedules" ADD CONSTRAINT "fleet_report_schedules_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_report_dispatches" ADD CONSTRAINT "fleet_report_dispatches_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
