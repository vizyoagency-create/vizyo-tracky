-- Historique des passages d'automatisation des trajets (audit : quand / pour qui / quoi
-- + récits produits cliquables). Élagué côté service (garde les N runs récents).
-- Migration HAND-WRITTEN (chirurgicale, anti-drift) — ne pas régénérer via `migrate dev`.

-- CreateTable
CREATE TABLE "trip_automation_runs" (
    "id" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "origin" TEXT NOT NULL DEFAULT 'scheduled',
    "fleets" INTEGER NOT NULL DEFAULT 0,
    "vehicles" INTEGER NOT NULL DEFAULT 0,
    "recomputed" INTEGER NOT NULL DEFAULT 0,
    "analyzed" INTEGER NOT NULL DEFAULT 0,
    "narrated" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "items" JSONB,

    CONSTRAINT "trip_automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_automation_runs_startedAt_idx" ON "trip_automation_runs"("startedAt" DESC);
