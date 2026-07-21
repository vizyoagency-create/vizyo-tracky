-- Lot 2 — mode « usage mixte » par vehicule (proportionnalite CNIL).
-- false (defaut) = vehicule purement professionnel : trace 24/7, antivol actif.
-- true = le cadre de temps de travail s'applique : hors plage, aucune position n'est collectee.
-- Les vehicules existants restent traces (aucun changement de comportement retroactif).
ALTER TABLE "vehicles" ADD COLUMN "mixedUseEnabled" BOOLEAN NOT NULL DEFAULT false;
