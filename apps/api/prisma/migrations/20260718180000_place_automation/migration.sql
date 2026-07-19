-- Automatisation des analyses de lieux + empreinte des faits (garde-fou de cout).
--
-- `place_analyses.factsHash` : empreinte des faits sources. Si les faits n'ont pas bouge depuis la
-- derniere analyse, re-analyser produirait le meme texte pour le meme prix -> on saute. Nullable :
-- les analyses anterieures n'en ont pas, et une empreinte NULL ne doit JAMAIS faire sauter un lieu.

ALTER TABLE "place_analyses" ADD COLUMN IF NOT EXISTS "factsHash" TEXT;

-- Reglages (singleton). OPT-IN : enabled=false -> aucune depense tant que rien n'est active.
CREATE TABLE "place_automation_settings" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "hour" INTEGER NOT NULL DEFAULT 3,
    "minIntervalDays" INTEGER NOT NULL DEFAULT 30,
    "skipUnchanged" BOOLEAN NOT NULL DEFAULT true,
    "maxAnalysesPerRun" INTEGER NOT NULL DEFAULT 20,
    "maxCostEurPerRun" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStats" JSONB,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "place_automation_settings_pkey" PRIMARY KEY ("id")
);

-- Historique des runs : combien analyses, combien SAUTES et pourquoi, cout reel, raison d'arret.
CREATE TABLE "place_automation_runs" (
    "id" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "origin" TEXT NOT NULL DEFAULT 'scheduled',
    "fleets" INTEGER NOT NULL DEFAULT 0,
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "analyzed" INTEGER NOT NULL DEFAULT 0,
    "skippedUnchanged" INTEGER NOT NULL DEFAULT 0,
    "skippedCooldown" INTEGER NOT NULL DEFAULT 0,
    "skippedAiOff" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "costEur" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "stopReason" TEXT NOT NULL DEFAULT 'completed',
    "items" JSONB,

    CONSTRAINT "place_automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "place_automation_runs_startedAt_idx" ON "place_automation_runs"("startedAt" DESC);
