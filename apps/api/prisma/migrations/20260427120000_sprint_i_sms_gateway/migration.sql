-- V1.5 (Sprint I) — SMS Gateway (Twilio) reserve SUPER_ADMIN.
-- Permet le provisionnement d'un tracker neuf via sequence de 9 SMS Coban,
-- + sert de fallback pour les commandes fix mode quand la socket TCP est
-- indisponible > 5 minutes.

-- 1) Status provisionnement
CREATE TYPE "TrackerProvisioningStatus" AS ENUM (
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

-- 2) Table provisionnement (state machine 9 SMS)
CREATE TABLE "tracker_provisionings" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "imei"            TEXT NOT NULL,
  "phoneNumber"     TEXT NOT NULL,
  "status"          "TrackerProvisioningStatus" NOT NULL DEFAULT 'PENDING',
  "currentStep"     INTEGER NOT NULL DEFAULT 0,
  "apn"             TEXT,
  "apnUser"         TEXT,
  "apnPasswd"       TEXT,
  "serverIp"        TEXT,
  "serverPort"      INTEGER,
  "lowBatteryPhone" TEXT,
  "steps"           JSONB NOT NULL DEFAULT '[]'::jsonb,
  "startedAt"       TIMESTAMP(3),
  "completedAt"     TIMESTAMP(3),
  "failedAt"        TIMESTAMP(3),
  "failureReason"   TEXT,
  "startedBy"       UUID NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tracker_provisionings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tracker_provisionings_imei_idx" ON "tracker_provisionings" ("imei");
CREATE INDEX "tracker_provisionings_status_idx" ON "tracker_provisionings" ("status");

-- 3) Numero SIM data sur Tracker (fallback SMS fix mode)
ALTER TABLE "trackers"
  ADD COLUMN "simPhoneNumber" TEXT;

-- 4) Table backup_runs (monitoring backups Postgres)
CREATE TABLE "backup_runs" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "status"       TEXT NOT NULL,
  "sizeBytes"    BIGINT,
  "durationMs"   INTEGER,
  "destination"  TEXT,
  "filename"     TEXT,
  "errorMessage" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backup_runs_createdAt_idx" ON "backup_runs" ("createdAt" DESC);

-- 5) Table audit SMS (sortants + entrants)
CREATE TABLE "sms_logs" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "direction"      TEXT NOT NULL,
  "fromNumber"     TEXT,
  "toNumber"       TEXT,
  "body"           TEXT NOT NULL,
  "twilioSid"      TEXT,
  "status"         TEXT,
  "errorCode"      TEXT,
  "errorMessage"   TEXT,
  "imei"           TEXT,
  "provisioningId" UUID,
  "context"        JSONB,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sms_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sms_logs_createdAt_idx" ON "sms_logs" ("createdAt" DESC);
CREATE INDEX "sms_logs_imei_idx" ON "sms_logs" ("imei");
CREATE INDEX "sms_logs_provisioningId_idx" ON "sms_logs" ("provisioningId");
