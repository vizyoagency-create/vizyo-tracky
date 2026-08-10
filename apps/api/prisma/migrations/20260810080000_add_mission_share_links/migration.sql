-- Espace depot (2026-08), lot A4 — le lien public temporaire de suivi de mission.
--
-- Ecrite a la main plutot que generee : `prisma migrate dev` voulait REINITIALISER la
-- base de developpement pour cause de derive historique (defauts de colonnes des
-- migrations anciennes). On n'efface pas une base de travail pour ajouter une table.

-- CreateEnum
CREATE TYPE "ShareDuration" AS ENUM ('MIN_15', 'HOUR_1', 'UNTIL_MISSION_END');

-- CreateTable
CREATE TABLE "mission_share_links" (
    "id" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    -- Opaque, 22 caracteres base62. JAMAIS un uuid de mission.
    "token" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    -- NOT NULL : un lien sans terme n'a aucun usage legitime.
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "duration" "ShareDuration" NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "firstOpenedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    -- Empreinte TRONQUEE (« 92.184.x.x »), jamais l'IP complete.
    "lastOpenedFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mission_share_links_token_key" ON "mission_share_links"("token");

-- CreateIndex
CREATE INDEX "mission_share_links_missionId_createdAt_idx" ON "mission_share_links"("missionId", "createdAt");

-- CreateIndex : l'index de la purge quotidienne des liens expires.
CREATE INDEX "mission_share_links_expiresAt_idx" ON "mission_share_links"("expiresAt");

-- AddForeignKey : la mission disparait, ses liens aussi. Un lien orphelin serait un
-- acces sans objet ni controle.
ALTER TABLE "mission_share_links" ADD CONSTRAINT "mission_share_links_missionId_fkey"
    FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey : le compte supprime emporte ses liens. Un lien sans auteur est un
-- acces que plus personne n'assume.
ALTER TABLE "mission_share_links" ADD CONSTRAINT "mission_share_links_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
