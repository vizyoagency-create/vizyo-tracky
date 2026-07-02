-- Agent IA d'optimisation d'agenda : rapports persistés + config/planification PAR FLOTTE.
CREATE TYPE "AgendaOptimizationAutonomy" AS ENUM ('PROPOSE', 'AUTO');

CREATE TABLE "agenda_optimization_reports" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fleetId" UUID NOT NULL,
    "createdByUserId" UUID,
    "fromAt" TIMESTAMP(3) NOT NULL,
    "toAt" TIMESTAMP(3) NOT NULL,
    "status" "ActivityReportStatus" NOT NULL DEFAULT 'READY',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "trigger" TEXT,
    "summary" TEXT,
    "proposals" JSONB,
    "error" TEXT,
    "model" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    CONSTRAINT "agenda_optimization_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agenda_optimization_reports_fleetId_createdAt_idx" ON "agenda_optimization_reports"("fleetId", "createdAt");
CREATE INDEX "agenda_optimization_reports_createdAt_idx" ON "agenda_optimization_reports"("createdAt");

CREATE TABLE "agenda_optimization_schedule" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "autonomy" "AgendaOptimizationAutonomy" NOT NULL DEFAULT 'PROPOSE',
    "lastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" UUID,
    CONSTRAINT "agenda_optimization_schedule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agenda_optimization_schedule_fleetId_key" ON "agenda_optimization_schedule"("fleetId");
