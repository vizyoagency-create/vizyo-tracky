-- Palier B — Journal des actions automatiques / système (arrière-plan).

-- CreateTable
CREATE TABLE "system_activity_logs" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "actor" TEXT,
    "target" TEXT,
    "detail" TEXT,
    "fleetId" UUID,
    "triggeredByUserId" UUID,
    "durationMs" INTEGER,
    "meta" JSONB,

    CONSTRAINT "system_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_activity_logs_createdAt_idx" ON "system_activity_logs"("createdAt");

-- CreateIndex
CREATE INDEX "system_activity_logs_category_createdAt_idx" ON "system_activity_logs"("category", "createdAt");

-- CreateIndex
CREATE INDEX "system_activity_logs_fleetId_createdAt_idx" ON "system_activity_logs"("fleetId", "createdAt");
