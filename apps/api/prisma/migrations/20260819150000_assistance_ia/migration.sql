-- Assistance IA (2026-08). Deux tables : la conversation, et ses messages.
--
-- Tout est conserve : l'espace admin doit pouvoir relire une reponse des mois plus tard, la
-- corriger, et recontacter la personne. Une assistance dont les echanges s'effacent ne permet
-- ni de mesurer la qualite de l'agent, ni de reparer ce qu'il a rate.

CREATE TABLE "assistance_conversations" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    -- Societe du demandeur AU MOMENT de la demande, figee volontairement : un utilisateur peut
    -- changer de societe, l'archive doit rester lisible sous le perimetre qui etait le sien.
    "fleetId" UUID,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    -- NULL tant qu'aucune synthese n'a ete produite : 'LOW' par defaut affirmerait « anodin »
    -- sans l'avoir juge.
    "severity" TEXT,
    "summary" JSONB,
    "escalatedAt" TIMESTAMP(3),
    "escalatedReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" UUID,
    "reviewNote" TEXT,

    CONSTRAINT "assistance_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assistance_messages" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversationId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    -- Trace d'audit du cloisonnement : QUELLES donnees ont ete montrees au modele. Cles des
    -- lots et volumes seulement, jamais les donnees elles-memes.
    "contextUsed" JSONB,

    CONSTRAINT "assistance_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistance_conversations_userId_createdAt_idx" ON "assistance_conversations"("userId", "createdAt" DESC);
CREATE INDEX "assistance_conversations_fleetId_createdAt_idx" ON "assistance_conversations"("fleetId", "createdAt" DESC);
CREATE INDEX "assistance_conversations_status_createdAt_idx" ON "assistance_conversations"("status", "createdAt" DESC);
CREATE INDEX "assistance_messages_conversationId_createdAt_idx" ON "assistance_messages"("conversationId", "createdAt");

ALTER TABLE "assistance_conversations" ADD CONSTRAINT "assistance_conversations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assistance_messages" ADD CONSTRAINT "assistance_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "assistance_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
