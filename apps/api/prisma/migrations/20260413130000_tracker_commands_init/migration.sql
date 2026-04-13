-- CreateEnum
CREATE TYPE "TrackerCommandStatus" AS ENUM ('PENDING', 'SCHEDULED', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrackerCommandChannel" AS ENUM ('TCP', 'SMS');

-- CreateTable
CREATE TABLE "tracker_commands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trackerId" UUID NOT NULL,
    "templateId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "payload" TEXT NOT NULL,
    "channel" "TrackerCommandChannel" NOT NULL DEFAULT 'TCP',
    "status" "TrackerCommandStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "ackResponse" TEXT,
    "lastError" TEXT,
    "requestedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracker_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracker_commands_trackerId_createdAt_idx" ON "tracker_commands"("trackerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tracker_commands_status_idx" ON "tracker_commands"("status");

-- CreateIndex
CREATE INDEX "tracker_commands_scheduledAt_idx" ON "tracker_commands"("scheduledAt");

-- AddForeignKey
ALTER TABLE "tracker_commands" ADD CONSTRAINT "tracker_commands_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "trackers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracker_commands" ADD CONSTRAINT "tracker_commands_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
