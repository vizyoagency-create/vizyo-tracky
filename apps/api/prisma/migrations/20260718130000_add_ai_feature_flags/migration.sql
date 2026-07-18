-- Switchboard IA (2026-07-18) — interrupteurs GLOBAUX par fonctionnalite IA (kill-switch plateforme).
-- Migration HAND-WRITTEN (chirurgicale, anti-drift). Singleton, tout ON par defaut (fail-open).
CREATE TABLE "ai_feature_flags" (
    "id" UUID NOT NULL,
    "tripAnalysis" BOOLEAN NOT NULL DEFAULT true,
    "agendaAgent" BOOLEAN NOT NULL DEFAULT true,
    "capacity" BOOLEAN NOT NULL DEFAULT true,
    "placement" BOOLEAN NOT NULL DEFAULT true,
    "bookingParse" BOOLEAN NOT NULL DEFAULT true,
    "activityReport" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_feature_flags_pkey" PRIMARY KEY ("id")
);
