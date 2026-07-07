-- Refonte agenda/IA (2026-07, P4) — Lien PUBLIC de demande de réservation (société fixe).
-- Un tiers décrit un besoin sur une page hors auth ; l'app propose des véhicules dispo ;
-- la demande atterrit en REQUESTED (file de validation).

-- CreateTable
CREATE TABLE "reservation_booking_links" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "horizonDays" INTEGER NOT NULL DEFAULT 30,
    "leadHours" INTEGER NOT NULL DEFAULT 2,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "firstOpenedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservation_booking_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_booking_links_token_key" ON "reservation_booking_links"("token");

-- CreateIndex
CREATE INDEX "reservation_booking_links_fleetId_createdAt_idx" ON "reservation_booking_links"("fleetId", "createdAt");

-- AddForeignKey
ALTER TABLE "reservation_booking_links" ADD CONSTRAINT "reservation_booking_links_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
