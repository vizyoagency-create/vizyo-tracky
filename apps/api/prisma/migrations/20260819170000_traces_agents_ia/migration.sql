-- Ce qu'on a ENVOYE a un modele, et ce qu'il a RENDU — le couple, pas seulement le resultat.
--
-- L'application conservait deja les RESULTATS (recit d'un trajet, contenu d'un rapport,
-- propositions d'agenda) mais jamais l'ENTREE. Or on n'ameliore pas un agent en relisant ses
-- bonnes reponses : on l'ameliore en retrouvant les payloads qui ont produit une reponse fausse,
-- vide ou hors sujet. Sans l'entree, un echec n'est pas reproductible.
--
-- ⚠️ Cette table DUPLIQUE de la donnee metier hors de sa table d'origine. D'ou `fleetId` (purger
--    avec la societe), un plafond par action applique a l'insertion, et des payloads bornes.

CREATE TABLE "ai_agent_traces" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "executor" TEXT NOT NULL DEFAULT 'api',
    "model" TEXT,
    "fleetId" UUID,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "latencyMs" INTEGER,
    -- `concluant` ou `rejete` : c'est CE champ qui separe les cas a rejouer du bruit.
    "verdict" TEXT NOT NULL,
    "verdictNote" TEXT,

    CONSTRAINT "ai_agent_traces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_agent_traces_action_createdAt_idx" ON "ai_agent_traces"("action", "createdAt" DESC);
CREATE INDEX "ai_agent_traces_verdict_createdAt_idx" ON "ai_agent_traces"("verdict", "createdAt" DESC);
CREATE INDEX "ai_agent_traces_fleetId_idx" ON "ai_agent_traces"("fleetId");
