-- V1.15 — Plannings d'installation de boitiers GPS.
-- Additif uniquement : 2 nouvelles tables + 3 enums. Les FK vers vehicles/trackers
-- sont portees par installation_tasks (ON DELETE SET NULL) → supprimer un plan ou
-- une tache n'efface jamais le vehicule/tracker reel deja operationnel.

-- CreateEnum
CREATE TYPE "InstallationPlanStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "InstallationTaskStatus" AS ENUM ('PENDING', 'DONE', 'SKIPPED');
CREATE TYPE "InstallationEnergy" AS ENUM ('DIESEL', 'ESSENCE', 'ELECTRIQUE', 'HYBRIDE', 'AUTRE');

-- CreateTable
CREATE TABLE "installation_plans" (
  "id"            UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "fleetId"       UUID                     NOT NULL,
  "clientName"    TEXT                     NOT NULL,
  "clientAddress" TEXT,
  "description"   TEXT,
  "startDate"     DATE,
  "endDate"       DATE,
  "status"        "InstallationPlanStatus" NOT NULL DEFAULT 'DRAFT',
  "dayThemes"     JSONB,
  "createdAt"     TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "installation_plans_fleetId_idx"        ON "installation_plans"("fleetId");
CREATE INDEX "installation_plans_fleetId_status_idx" ON "installation_plans"("fleetId", "status");

-- CreateTable
CREATE TABLE "installation_tasks" (
  "id"                    UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  "planId"                UUID                     NOT NULL,
  "orderIndex"            INTEGER                  NOT NULL,
  "scheduledDate"         DATE,
  "plate"                 TEXT                     NOT NULL,
  "brand"                 TEXT,
  "model"                 TEXT,
  "energy"                "InstallationEnergy",
  "firstRegistrationDate" DATE,
  "cutoffProcedure"       TEXT,
  "status"                "InstallationTaskStatus" NOT NULL DEFAULT 'PENDING',
  "installedAt"           TIMESTAMP(3),
  "imei"                  TEXT,
  "simNumber"             TEXT,
  "fieldNotes"            TEXT,
  "vehicleId"             UUID,
  "trackerId"             UUID,
  "createdAt"             TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "installation_tasks_planId_orderIndex_idx"    ON "installation_tasks"("planId", "orderIndex");
CREATE INDEX "installation_tasks_planId_scheduledDate_idx" ON "installation_tasks"("planId", "scheduledDate");
CREATE INDEX "installation_tasks_vehicleId_idx"            ON "installation_tasks"("vehicleId");
CREATE INDEX "installation_tasks_trackerId_idx"            ON "installation_tasks"("trackerId");

-- AddForeignKey
ALTER TABLE "installation_plans"
  ADD CONSTRAINT "installation_plans_fleetId_fkey"
  FOREIGN KEY ("fleetId") REFERENCES "fleets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "installation_tasks"
  ADD CONSTRAINT "installation_tasks_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "installation_plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "installation_tasks"
  ADD CONSTRAINT "installation_tasks_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "installation_tasks"
  ADD CONSTRAINT "installation_tasks_trackerId_fkey"
  FOREIGN KEY ("trackerId") REFERENCES "trackers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMENT ON TABLE "installation_plans" IS 'V1.15 — Planning d''installation de boitiers GPS pour une flotte cliente.';
COMMENT ON TABLE "installation_tasks" IS 'V1.15 — Une ligne = un vehicule a equiper (sens d''installation via orderIndex/scheduledDate).';
COMMENT ON COLUMN "installation_plans"."dayThemes" IS 'JSON { "YYYY-MM-DD": "theme" } — themes de journee (evite une 3eme table).';
