-- ── UNE ANALYSE DE CAPACITÉS PAR JOUR ET PAR SOCIÉTÉ, CONSERVÉE (refonte UX de l'agenda, 2026-09-28) ──
--
-- Avant : le résultat de l'analyse IA des capacités (places / équipements par véhicule) vivait dans
-- le navigateur (localStorage, P1-5) et l'analyse se relançait à volonté « alors que cela ne va rien
-- changer » — chaque relance facturée. Ici : la dernière analyse d'une société est en base,
-- lisible de tout poste, appliquée véhicule par véhicule (`appliedVehicleIds`), et le serveur
-- refuse d'en payer une nouvelle avant 24 h.
--
-- Pas de clé étrangère vers `fleets` : même convention que `ai_usage_logs` (une trace d'usage
-- survit à la société qui l'a produite, et ne bloque jamais sa suppression).
CREATE TABLE "ai_capacity_analyses" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "metier" TEXT NOT NULL,
    "proposals" JSONB NOT NULL,
    "proposalsCount" INTEGER NOT NULL DEFAULT 0,
    "appliedVehicleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ai_capacity_analyses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_capacity_analyses_fleetId_createdAt_idx" ON "ai_capacity_analyses"("fleetId", "createdAt");
