-- CreateTable
CREATE TABLE "system_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loadAvg1" DOUBLE PRECISION NOT NULL,
    "loadAvg5" DOUBLE PRECISION NOT NULL,
    "loadAvg15" DOUBLE PRECISION NOT NULL,
    "cpuCount" INTEGER NOT NULL,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memUsedMb" DOUBLE PRECISION NOT NULL,
    "memTotalMb" DOUBLE PRECISION NOT NULL,
    "dbSizeMb" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "system_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_metrics_timestamp_idx" ON "system_metrics"("timestamp");
