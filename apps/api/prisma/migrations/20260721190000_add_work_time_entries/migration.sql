-- RGPD 4.5 — registre du temps de travail : agregats journaliers par conducteur, SANS positions.
-- Retention propre 5 ans (purge dans le cron d'agregation). Conserve apres anonymisation.

CREATE TABLE "work_time_entries" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "firstTripStart" TIMESTAMP(3) NOT NULL,
    "lastTripEnd" TIMESTAMP(3) NOT NULL,
    "drivingSeconds" INTEGER NOT NULL,
    "tripsCount" INTEGER NOT NULL,
    "vehiclePlates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_time_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_time_entries_driverId_day_key" ON "work_time_entries"("driverId", "day");
CREATE INDEX "work_time_entries_fleetId_day_idx" ON "work_time_entries"("fleetId", "day");
