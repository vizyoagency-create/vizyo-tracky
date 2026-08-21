-- Vehicules HORS SERVICE — cas speciaux declares par un super-admin.
--
-- Pourquoi : un vehicule qui ne roule plus (accident, boitier debranche, immobilisation longue)
-- reste dans le perimetre de tous les traitements de fond. Il y produit un flot de travail
-- impossible et d'alertes vraies-mais-inutiles. Mesure du 2026-08-21 sur KSR370, accidente :
-- 843 trajets a re-segmenter et 1 309 a analyser, soit 99 % du reste-a-faire de TOUTE la flotte
-- pour un seul vehicule qui ne roulera plus. Impossible de savoir, en regardant les compteurs,
-- si la convergence avance ou pas.
--
-- La colonne est NULLABLE et sans defaut : l'absence de valeur signifie « en service », donc
-- l'existant reste strictement inchange. Aucune donnee n'est touchee, aucun trajet supprime —
-- un vehicule remis en service retrouve exactement son comportement d'avant.
CREATE TYPE "VehicleOutOfServiceReason" AS ENUM ('ACCIDENT', 'TRACKER_UNPLUGGED', 'IMMOBILIZED');

ALTER TABLE "vehicles"
  ADD COLUMN "outOfServiceReason" "VehicleOutOfServiceReason",
  ADD COLUMN "outOfServiceSince"  TIMESTAMP(3),
  ADD COLUMN "outOfServiceById"   UUID,
  ADD COLUMN "outOfServiceNote"   TEXT;
