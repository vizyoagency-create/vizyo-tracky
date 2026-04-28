-- V1.7 — Flag installation matérielle : fil ACC du tracker connecté ou non.
--
-- Quand `accConnected = false`, le serveur infère `ignition` depuis la vitesse
-- GPS (heuristique appliquée dans PositionsService.ingest). Ce flag est
-- réglable uniquement par SUPER_ADMIN depuis la fiche véhicule.
--
-- Default `true` (rétrocompat — cas standard où le fil ACC jaune est branché
-- au +12V après contact). Le SUPER_ADMIN décoche manuellement pour les
-- installations dégradées (ex: véhicule électrique sans +12V acc, ou
-- installation rapide sans accès au +12V).

ALTER TABLE "trackers"
  ADD COLUMN "accConnected" BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN "trackers"."accConnected" IS
  'true = fil ACC jaune connecte au +12V apres contact. false = ACC non cable, ignition inferee depuis la vitesse GPS (heuristique >3 km/h => ON).';
