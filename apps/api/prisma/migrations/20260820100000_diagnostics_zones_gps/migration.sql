-- Diagnostic de ZONE MORTE : plusieurs vehicules perdent le signal au meme endroit.
--
-- Une zone de perte est apprise PAR VEHICULE ; le diagnostic porte sur le LIEU et agrege
-- plusieurs zones et plusieurs vehicules. Il n'a donc pas de ligne d'accueil naturelle, et le
-- champ `note` des zones appartient a la revue humaine — l'ecraser chaque nuit effacerait le
-- travail d'un operateur.
--
-- `cle` UNIQUE (societe + coordonnees arrondies) : c'est elle qui empeche l'agent de recreer le
-- meme diagnostic chaque nuit.

CREATE TABLE "gps_zone_diagnostics" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fleetId" UUID NOT NULL,
    "cle" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "placeLabel" TEXT,
    "vehicules" TEXT[],
    "episodes" INTEGER NOT NULL DEFAULT 0,
    "etalementM" INTEGER NOT NULL DEFAULT 0,
    "constat" TEXT NOT NULL,
    "recommandation" TEXT NOT NULL,
    "traiteAt" TIMESTAMP(3),
    "traiteParUserId" UUID,
    "note" TEXT,

    CONSTRAINT "gps_zone_diagnostics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gps_zone_diagnostics_cle_key" ON "gps_zone_diagnostics"("cle");
CREATE INDEX "gps_zone_diagnostics_fleetId_createdAt_idx" ON "gps_zone_diagnostics"("fleetId", "createdAt" DESC);
CREATE INDEX "gps_zone_diagnostics_traiteAt_idx" ON "gps_zone_diagnostics"("traiteAt");
