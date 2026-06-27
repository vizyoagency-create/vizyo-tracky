-- Sprint 4 — Écoute audio à distance (micro embarqué), LÉGALEMENT CRITIQUE.
-- Scénario A confirmé (appel live) : AUCUN clip uploadé → pas de table AudioClip,
-- pas de clipId, pas de rétention de clip. Ici : audit immuable des commandes (#7)
-- + activation par flotte avec attestation (#1/#5).

-- CreateEnum
CREATE TYPE "AudioCommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "audio_monitoring_commands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trackerId" UUID NOT NULL,
    "vehicleId" UUID,
    "fleetId" UUID NOT NULL,
    "status" "AudioCommandStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "requestedBy" UUID NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "requestedInEnv" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audio_monitoring_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_audio_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fleetId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "attestedByUserId" UUID,
    "attestedAt" TIMESTAMP(3),
    "attestationVersion" TEXT,
    "activationEmailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_audio_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audio_monitoring_commands_fleetId_createdAt_idx" ON "audio_monitoring_commands"("fleetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audio_monitoring_commands_vehicleId_createdAt_idx" ON "audio_monitoring_commands"("vehicleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audio_monitoring_commands_trackerId_status_idx" ON "audio_monitoring_commands"("trackerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_audio_configs_fleetId_key" ON "fleet_audio_configs"("fleetId");

-- AddForeignKey
ALTER TABLE "audio_monitoring_commands" ADD CONSTRAINT "audio_monitoring_commands_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "trackers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_audio_configs" ADD CONSTRAINT "fleet_audio_configs_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
