-- Historique des passages de l'agent d'agenda.
--
-- Jusqu'ici seul `agenda_agent_settings.lastRunAt` survivait : on savait QUAND l'agent avait
-- tourne, jamais ce qu'il avait fait, ni pourquoi un passage n'avait rien donne. Une ligne par
-- passage REEL (un passage saute -- agent desactive, ou un autre deja en cours -- n'execute rien
-- et ne produit donc pas de ligne).
--
-- `fleetId` denormalise (pas de FK), meme convention que agenda_agent_proposals.

CREATE TABLE "agenda_agent_runs" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "origin" TEXT NOT NULL DEFAULT 'scheduled',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "patterns" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "proposed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "aiUsed" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "agenda_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex : lecture « derniers passages d'une societe ».
CREATE INDEX "agenda_agent_runs_fleetId_startedAt_idx" ON "agenda_agent_runs"("fleetId", "startedAt");
