-- Couche IA multi-provider (2026-07) — provider IA sélectionné (singleton, comme ai_budget).
-- Togglé depuis la page « Coûts IA » (super-admin). 'claude' (Anthropic) | 'gpt' (OpenAI).
--
-- NOTE : migration RENDUE CHIRURGICALE à la main. `prisma migrate dev` avait capturé du drift
-- (DROP DEFAULT sur de nombreuses tables, ajouts d'enum AlertType, changements de type) dû à une
-- base de DEV en retard sur le schéma — CES CHANGEMENTS SONT DÉJÀ EN PROD via l'historique de
-- migrations et ne doivent PAS être rejoués ici. Seule la création de la table est conservée.

-- CreateTable
CREATE TABLE "ai_provider_settings" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'claude',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" UUID,

    CONSTRAINT "ai_provider_settings_pkey" PRIMARY KEY ("id")
);
