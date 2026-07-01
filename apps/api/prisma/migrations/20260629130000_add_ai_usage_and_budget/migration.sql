-- Palier « Coûts IA » — journal d'usage IA (1 ligne par appel Claude réussi) + budget mensuel (singleton).

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID,
    "fleetId" UUID,
    "model" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_logs_createdAt_idx" ON "ai_usage_logs"("createdAt");
CREATE INDEX "ai_usage_logs_fleetId_createdAt_idx" ON "ai_usage_logs"("fleetId", "createdAt");
CREATE INDEX "ai_usage_logs_userId_createdAt_idx" ON "ai_usage_logs"("userId", "createdAt");
CREATE INDEX "ai_usage_logs_action_idx" ON "ai_usage_logs"("action");

-- CreateTable
CREATE TABLE "ai_budget" (
    "id" UUID NOT NULL,
    "monthlyBudgetEur" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" UUID,

    CONSTRAINT "ai_budget_pkey" PRIMARY KEY ("id")
);
