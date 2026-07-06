-- Refonte agenda/IA (2026-07, P3) — Propositions de l'agent nocturne (par flotte).
-- Suggestion (pending) OU réservation auto (auto_applied). Unicité (fleet, véhicule, créneau)
-- pour ne pas re-proposer la même occurrence à chaque nuit.

-- CreateTable
CREATE TABLE "agenda_agent_proposals" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "destinationLabel" TEXT,
    "destLat" DOUBLE PRECISION NOT NULL,
    "destLng" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "basis" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdEventId" UUID,
    "origin" TEXT NOT NULL DEFAULT 'scheduled',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agenda_agent_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agenda_agent_proposals_fleetId_vehicleId_startAt_key" ON "agenda_agent_proposals"("fleetId", "vehicleId", "startAt");

-- CreateIndex
CREATE INDEX "agenda_agent_proposals_fleetId_status_startAt_idx" ON "agenda_agent_proposals"("fleetId", "status", "startAt");
