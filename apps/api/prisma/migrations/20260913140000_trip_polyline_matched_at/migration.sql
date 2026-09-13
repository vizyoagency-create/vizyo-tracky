-- TRK-016 / T28 (2026-09-13) — dater et signer le trace recale.
--
-- Un taux calcule sur `polylineMatched IS NULL` dans une fenetre glissante melangeait ce que le
-- recalage fait A LA CLOTURE du trajet et ce que le rattrapage fait RETROACTIVEMENT la nuit
-- suivante : trois jours de suite, le passe s'est reecrit. Ces deux colonnes rendent la
-- distinction possible ; elles restent nulles pour les traces poses avant cette migration.
-- Additive, sans valeur par defaut : aucune reecriture de l'existant.

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "polylineMatchedAt" TIMESTAMP(3),
ADD COLUMN     "polylineMatchedSource" TEXT;