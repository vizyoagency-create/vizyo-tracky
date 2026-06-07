-- V1.16 — Parc de cartes SIM M2M (WhereverSIM).
-- Additif : 1 nouvelle table `sims` (miroir WhereverSIM + couche Tracky).
-- Les FK fleetId/trackerId sont en ON DELETE SET NULL : supprimer une flotte ou
-- un tracker ne supprime jamais la SIM (elle retourne au stock).

-- CreateTable
CREATE TABLE "sims" (
  "id"                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "iccid"                    TEXT         NOT NULL,
  "msisdn"                   TEXT,
  "imsi"                     TEXT,
  "imei"                     TEXT,
  "provider"                 TEXT         NOT NULL DEFAULT 'wherever-sim',
  "providerId"               INTEGER,
  "statusId"                 INTEGER,
  "statusLabel"              TEXT,
  "apn"                      TEXT,
  "ipAddress"                TEXT,
  "networkOperator"          TEXT,
  "monthlyDataVolumeBytes"   BIGINT,
  "monthlyDataLimitBytes"    BIGINT,
  "prevMonthDataVolumeBytes" BIGINT,
  "inSessionSince"           TIMESTAMP(3),
  "activationAt"             TIMESTAMP(3),
  "customField1"             TEXT,
  "label"                    TEXT,
  "fleetId"                  UUID,
  "trackerId"                UUID,
  "notes"                    TEXT,
  "externalSyncedAt"         TIMESTAMP(3),
  "rawProvider"              JSONB,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "sims_iccid_key" ON "sims"("iccid");
CREATE UNIQUE INDEX "sims_trackerId_key" ON "sims"("trackerId");
CREATE INDEX "sims_fleetId_idx" ON "sims"("fleetId");
CREATE INDEX "sims_statusId_idx" ON "sims"("statusId");

-- AddForeignKey
ALTER TABLE "sims" ADD CONSTRAINT "sims_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sims" ADD CONSTRAINT "sims_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "trackers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
