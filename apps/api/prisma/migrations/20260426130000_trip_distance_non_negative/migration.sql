-- Defense en profondeur : aucune distance ne doit etre negative en base.
-- Etape 1 : nettoyer les eventuelles lignes legacy (clamp a 0).
UPDATE "trips" SET "distanceMeters" = 0 WHERE "distanceMeters" < 0;
UPDATE "trips" SET "distanceKm" = 0 WHERE "distanceKm" < 0;

-- Etape 2 : poser une CHECK constraint pour rejeter toute ecriture future negative.
ALTER TABLE "trips"
  ADD CONSTRAINT "trips_distance_meters_non_negative" CHECK ("distanceMeters" >= 0),
  ADD CONSTRAINT "trips_distance_km_non_negative"     CHECK ("distanceKm"     >= 0);
