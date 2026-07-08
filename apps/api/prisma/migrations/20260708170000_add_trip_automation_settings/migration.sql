-- Automatisation trajets (2026-07) — planification réglable (singleton) du pipeline
-- « recalcul des trajets → analyse déterministe → récit IA » pour toutes les flottes.
-- Piloté depuis l'espace super-admin ; consommé par TripAutomationService (cron horaire).
-- Migration HAND-WRITTEN (chirurgicale, anti-drift) — ne pas régénérer via `migrate dev`.

-- CreateTable
CREATE TABLE "trip_automation_settings" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequency" TEXT NOT NULL DEFAULT 'hourly',
    "hour" INTEGER NOT NULL DEFAULT 2,
    "lookbackHours" INTEGER NOT NULL DEFAULT 26,
    "recomputeTrips" BOOLEAN NOT NULL DEFAULT true,
    "narrateEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxAnalysesPerRun" INTEGER NOT NULL DEFAULT 300,
    "maxNarrationsPerRun" INTEGER NOT NULL DEFAULT 60,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStats" JSONB,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trip_automation_settings_pkey" PRIMARY KEY ("id")
);
