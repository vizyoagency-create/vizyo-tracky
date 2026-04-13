-- CreateTable
CREATE TABLE "wire_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "imei" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "frameType" TEXT,
    "commandId" UUID,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wire_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "error_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "imei" TEXT,
    "commandId" UUID,
    "userId" UUID,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wire_logs_imei_createdAt_idx" ON "wire_logs"("imei", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "wire_logs_commandId_idx" ON "wire_logs"("commandId");

-- CreateIndex
CREATE INDEX "wire_logs_createdAt_idx" ON "wire_logs"("createdAt");

-- CreateIndex
CREATE INDEX "error_logs_source_createdAt_idx" ON "error_logs"("source", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "error_logs_imei_idx" ON "error_logs"("imei");

-- CreateIndex
CREATE INDEX "error_logs_commandId_idx" ON "error_logs"("commandId");

-- CreateIndex
CREATE INDEX "error_logs_createdAt_idx" ON "error_logs"("createdAt");
