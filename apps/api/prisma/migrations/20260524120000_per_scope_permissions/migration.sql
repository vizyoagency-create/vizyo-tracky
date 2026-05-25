-- V1.11 Phase 1 — Refonte permissions : portage des permissions sur les lignes d'acces.
-- Ajoute permissions JSONB + timestamps + index composite sur user_vehicle_access.
-- Cf. plan sharded-mixing-shore.md sections A.1/A.2.

-- AlterTable
ALTER TABLE "user_vehicle_access"
  ADD COLUMN "permissions" JSONB,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "user_vehicle_access_userId_accessType_idx"
  ON "user_vehicle_access"("userId", "accessType");
