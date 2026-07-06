-- Mode vie privée conducteur (par véhicule). Quand ON, aucune position n'est
-- collectée/diffusée (trame jetée à l'ingestion). État courant porté par le véhicule
-- + historique complet des bascules (traçabilité qui/quand/note) dans une table dédiée.

-- AlterTable Vehicle : état courant du mode privé.
ALTER TABLE "vehicles" ADD COLUMN "privacyModeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "vehicles" ADD COLUMN "privacyModeSince" TIMESTAMP(3);
ALTER TABLE "vehicles" ADD COLUMN "privacyModeById" UUID;
ALTER TABLE "vehicles" ADD COLUMN "privacyModeNote" TEXT;

-- CreateTable : historique des bascules.
CREATE TABLE "privacy_mode_events" (
    "id" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_mode_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "privacy_mode_events_vehicleId_createdAt_idx" ON "privacy_mode_events"("vehicleId", "createdAt");

-- CreateIndex
CREATE INDEX "privacy_mode_events_fleetId_createdAt_idx" ON "privacy_mode_events"("fleetId", "createdAt");

-- AddForeignKey
ALTER TABLE "privacy_mode_events" ADD CONSTRAINT "privacy_mode_events_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
