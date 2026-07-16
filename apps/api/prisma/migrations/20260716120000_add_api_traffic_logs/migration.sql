-- Observabilité du trafic API PUBLIC + intelligence IP (demande client 2026-07).
-- Une ligne = un hit d'API publique (kind='REQUEST') ou un beacon partenaire (kind='PARTNER_EVENT').

-- CreateTable
CREATE TABLE "api_traffic_logs" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "method" TEXT,
    "path" TEXT,
    "statusCode" INTEGER,
    "action" TEXT,
    "target" TEXT,
    "ip" TEXT,
    "ipKnown" BOOLEAN NOT NULL DEFAULT false,
    "userId" UUID,
    "userAgent" TEXT,
    "durationMs" INTEGER,
    "meta" JSONB,

    CONSTRAINT "api_traffic_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_traffic_logs_createdAt_idx" ON "api_traffic_logs"("createdAt");

-- CreateIndex
CREATE INDEX "api_traffic_logs_ip_createdAt_idx" ON "api_traffic_logs"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "api_traffic_logs_source_createdAt_idx" ON "api_traffic_logs"("source", "createdAt");

-- CreateIndex
CREATE INDEX "api_traffic_logs_kind_createdAt_idx" ON "api_traffic_logs"("kind", "createdAt");
