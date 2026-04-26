-- Denormalisation de la derniere position sur la table trackers.
-- Permet l'hydratation immediate de la carte au login sans attendre une nouvelle trame.

ALTER TABLE "trackers"
  ADD COLUMN "lastLat"        DOUBLE PRECISION,
  ADD COLUMN "lastLng"        DOUBLE PRECISION,
  ADD COLUMN "lastSpeedKmh"   DOUBLE PRECISION,
  ADD COLUMN "lastHeading"    DOUBLE PRECISION,
  ADD COLUMN "lastIgnition"   BOOLEAN,
  ADD COLUMN "lastValid"      BOOLEAN,
  ADD COLUMN "lastPositionAt" TIMESTAMP(3);

-- Backfill : pour chaque tracker, copier la position la plus recente depuis la table positions.
UPDATE "trackers" t
SET
  "lastLat"        = p."lat",
  "lastLng"        = p."lng",
  "lastSpeedKmh"   = p."speedKmh",
  "lastHeading"    = p."heading",
  "lastValid"      = p."valid",
  "lastPositionAt" = p."timestamp"
FROM (
  SELECT DISTINCT ON ("trackerId")
    "trackerId", "lat", "lng", "speedKmh", "heading", "valid", "timestamp"
  FROM "positions"
  ORDER BY "trackerId", "timestamp" DESC
) p
WHERE p."trackerId" = t."id";
