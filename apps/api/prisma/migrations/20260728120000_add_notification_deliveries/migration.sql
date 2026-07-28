-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "alertId" UUID,
    "alertType" TEXT,
    "severity" TEXT,
    "userId" UUID NOT NULL,
    "fleetId" UUID,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "title" TEXT,
    "body" TEXT,
    "deviceCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "groupedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_userId_createdAt_idx" ON "notification_deliveries"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "notification_deliveries_fleetId_createdAt_idx" ON "notification_deliveries"("fleetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "notification_deliveries_status_createdAt_idx" ON "notification_deliveries"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "notification_deliveries_alertId_idx" ON "notification_deliveries"("alertId");

-- CreateIndex
CREATE INDEX "notification_deliveries_createdAt_idx" ON "notification_deliveries"("createdAt");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

