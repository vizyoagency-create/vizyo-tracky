-- Refonte agenda/IA (2026-07) — Réglages de l'agent d'optimisation d'agenda, PAR FLOTTE.
-- Pilotés depuis la ⚙️ « Paramètres de l'agenda » ; consommés par l'agent nocturne (P3).

-- CreateTable
CREATE TABLE "agenda_agent_settings" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "nightlyHour" INTEGER NOT NULL DEFAULT 2,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "autonomy" TEXT NOT NULL DEFAULT 'suggest',
    "confidenceThreshold" INTEGER NOT NULL DEFAULT 80,
    "autoCompleteAfterReservation" BOOLEAN NOT NULL DEFAULT false,
    "triggerNightly" BOOLEAN NOT NULL DEFAULT true,
    "triggerIncident" BOOLEAN NOT NULL DEFAULT true,
    "triggerMaintenance" BOOLEAN NOT NULL DEFAULT true,
    "triggerReservation" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agenda_agent_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agenda_agent_settings_fleetId_key" ON "agenda_agent_settings"("fleetId");

-- AddForeignKey
ALTER TABLE "agenda_agent_settings" ADD CONSTRAINT "agenda_agent_settings_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
