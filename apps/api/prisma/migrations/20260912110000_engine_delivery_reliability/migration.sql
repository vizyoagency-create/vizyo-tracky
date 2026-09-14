-- Fiabilisation coupe-circuit : intention idempotente, worker durable et journal
-- de tentatives. Migration additive : aucune ligne historique n'est réinterprétée.
ALTER TABLE "engine_control_commands"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "activeKey" TEXT,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "dispatchLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "smsAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "alertedAt" TIMESTAMP(3),
  ADD COLUMN "smsLogId" UUID;

-- Date réelle d'observation du statut terminal. `createdAt` est la soumission et
-- ne permet pas de mesurer la fraîcheur d'un accusé reçu plus tard.
ALTER TABLE "sms_logs"
  ADD COLUMN "statusUpdatedAt" TIMESTAMP(3);
CREATE INDEX "sms_logs_status_statusUpdatedAt_idx"
  ON "sms_logs"("status", "statusUpdatedAt" DESC);

CREATE UNIQUE INDEX "engine_control_commands_idempotencyKey_key"
  ON "engine_control_commands"("idempotencyKey");
CREATE UNIQUE INDEX "engine_control_commands_activeKey_key"
  ON "engine_control_commands"("activeKey");
CREATE INDEX "engine_control_commands_restore_worker_idx"
  ON "engine_control_commands"("action", "status", "nextAttemptAt", "dispatchLeaseUntil");

CREATE TABLE "engine_delivery_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "commandId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "providerId" TEXT,
  "smsLogId" UUID,
  "rawCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "engine_delivery_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "engine_delivery_attempts_commandId_fkey"
    FOREIGN KEY ("commandId") REFERENCES "engine_control_commands"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "engine_delivery_attempts_channel_check" CHECK ("channel" IN ('TCP', 'SMS')),
  CONSTRAINT "engine_delivery_attempts_status_check" CHECK (
    "status" IN ('QUEUED', 'UNAVAILABLE', 'WRITTEN', 'ACCEPTED', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED', 'TIMED_OUT')
  )
);

CREATE UNIQUE INDEX "engine_delivery_attempts_commandId_attemptNumber_key"
  ON "engine_delivery_attempts"("commandId", "attemptNumber");
CREATE INDEX "engine_delivery_attempts_commandId_createdAt_idx"
  ON "engine_delivery_attempts"("commandId", "createdAt" DESC);
CREATE INDEX "engine_delivery_attempts_channel_status_createdAt_idx"
  ON "engine_delivery_attempts"("channel", "status", "createdAt");
