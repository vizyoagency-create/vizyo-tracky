-- A6 — l'historique des tournées de mission.
--
-- Migration PUREMENT ADDITIVE : une table, ses deux index, ses deux clés étrangères.
-- Aucune table existante n'est touchée, aucune colonne modifiée, aucune donnée réécrite.
-- Le diff a été écrit à la main plutôt que généré : sur ce dépôt, le générateur embarque
-- des ALTER TABLE sans rapport, dérive préexistante de la base locale (cf. docs/A6 § 8).
--
-- ⚠️ `authorUserId` est ON DELETE SET NULL, et `authorName` est NOT NULL. C'est
-- volontaire et c'est tout l'objet d'un journal : supprimer un compte ne doit pas
-- effacer qui a modifié une tournée facturée. Le nom est figé à l'écriture.
--
-- Les missions DÉJÀ EN BASE n'ont aucune révision : leur historique commence à leur
-- première modification. On ne fabrique pas de révision 0 rétroactive — elle porterait
-- une date et un auteur inventés, ce qui est pire qu'un historique qui commence tard.

-- CreateTable
CREATE TABLE "mission_stop_revisions" (
    "id" UUID NOT NULL,
    "missionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "authorUserId" UUID,
    "authorName" TEXT NOT NULL,
    "authorRole" "UserRole" NOT NULL,
    "reason" TEXT,
    "stops" JSONB NOT NULL,
    "distanceM" INTEGER,
    "amountCents" INTEGER,
    "previousAmountCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_stop_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mission_stop_revisions_missionId_idx" ON "mission_stop_revisions"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "mission_stop_revisions_missionId_position_key" ON "mission_stop_revisions"("missionId", "position");

-- AddForeignKey
ALTER TABLE "mission_stop_revisions" ADD CONSTRAINT "mission_stop_revisions_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_stop_revisions" ADD CONSTRAINT "mission_stop_revisions_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
