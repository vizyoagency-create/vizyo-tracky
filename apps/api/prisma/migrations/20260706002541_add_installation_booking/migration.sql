-- Prise de RDV en ligne (lien public de réservation de créneau d'installation).
-- Deux tables : le LIEN public (config créneaux + client pré-connu éventuel) et la
-- DEMANDE de créneau. Anti-double-réservation RACE-PROOF via une contrainte EXCLUDE
-- (btree_gist) : aucun créneau actif (PENDING/CONFIRMED) ne peut en chevaucher un
-- autre (capacité = 1 équipe de pose). Doublé d'un pré-check applicatif (409 lisible).

-- CreateEnum
CREATE TYPE "InstallationBookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "installation_booking_links" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "planId" UUID,
    "label" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientName" TEXT,
    "clientEmail" TEXT,
    "clientPhone" TEXT,
    "clientAddress" TEXT,
    "slotMinutes" INTEGER NOT NULL DEFAULT 120,
    "dayStartMinutes" INTEGER NOT NULL DEFAULT 480,
    "dayEndMinutes" INTEGER NOT NULL DEFAULT 1260,
    "workingDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "horizonDays" INTEGER NOT NULL DEFAULT 42,
    "leadHours" INTEGER NOT NULL DEFAULT 24,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "singleUse" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installation_booking_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installation_bookings" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "InstallationBookingStatus" NOT NULL DEFAULT 'PENDING',
    "clientName" TEXT NOT NULL,
    "clientEmail" TEXT NOT NULL,
    "clientPhone" TEXT,
    "clientAddress" TEXT,
    "vehiclePlate" TEXT,
    "vehicleBrand" TEXT,
    "vehicleModel" TEXT,
    "vehicleEnergy" "InstallationEnergy",
    "notes" TEXT,
    "taskId" UUID,
    "rejectionReason" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installation_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installation_booking_links_token_key" ON "installation_booking_links"("token");

-- CreateIndex
CREATE INDEX "installation_booking_links_fleetId_idx" ON "installation_booking_links"("fleetId");

-- CreateIndex
CREATE INDEX "installation_booking_links_token_idx" ON "installation_booking_links"("token");

-- CreateIndex
CREATE UNIQUE INDEX "installation_bookings_taskId_key" ON "installation_bookings"("taskId");

-- CreateIndex
CREATE INDEX "installation_bookings_linkId_idx" ON "installation_bookings"("linkId");

-- CreateIndex
CREATE INDEX "installation_bookings_fleetId_status_idx" ON "installation_bookings"("fleetId", "status");

-- CreateIndex
CREATE INDEX "installation_bookings_status_startAt_idx" ON "installation_bookings"("status", "startAt");

-- AddForeignKey
ALTER TABLE "installation_booking_links" ADD CONSTRAINT "installation_booking_links_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_booking_links" ADD CONSTRAINT "installation_booking_links_planId_fkey" FOREIGN KEY ("planId") REFERENCES "installation_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_bookings" ADD CONSTRAINT "installation_bookings_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "installation_booking_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installation_bookings" ADD CONSTRAINT "installation_bookings_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "installation_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Anti-double-réservation RACE-PROOF (capacité = 1 équipe) : aucun créneau ACTIF
-- (PENDING/CONFIRMED) ne peut en chevaucher un autre. tsrange [startAt, endAt) borne
-- basse incluse / haute exclue => créneaux jointifs autorisés (10-12 puis 12-14).
CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "installation_bookings" ADD CONSTRAINT "no_overlap_installation_booking"
  EXCLUDE USING gist (
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING', 'CONFIRMED'));
