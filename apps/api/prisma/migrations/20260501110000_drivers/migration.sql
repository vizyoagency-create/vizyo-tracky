-- Phase 2 — Conducteurs (drivers). Table dediee, separee de User pour permettre
-- des drivers "tag" sans login (variante hybride). Phase 3 future ajoutera
-- la possibilite de lier un driver a un compte User (role DRIVER).

CREATE TABLE "drivers" (
  "id"             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "fleetId"        UUID         NOT NULL,
  "firstName"      TEXT         NOT NULL,
  "lastName"       TEXT         NOT NULL,
  "phone"          TEXT,
  "email"          TEXT,
  "licenseNumber"  TEXT,
  "color"          TEXT         DEFAULT '#10E0A0',
  "notes"          TEXT,
  "isActive"       BOOLEAN      NOT NULL DEFAULT true,
  "userId"         UUID         UNIQUE,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "drivers_fleetId_idx"           ON "drivers"("fleetId");
CREATE INDEX "drivers_fleetId_isActive_idx"  ON "drivers"("fleetId", "isActive");

ALTER TABLE "drivers"
  ADD CONSTRAINT "drivers_fleetId_fkey"
  FOREIGN KEY ("fleetId") REFERENCES "fleets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "drivers"
  ADD CONSTRAINT "drivers_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMENT ON TABLE  "drivers"               IS 'Conducteurs d''une flotte. Variante hybride : un driver peut exister sans User lie (compte sans login).';
COMMENT ON COLUMN "drivers"."userId"      IS 'Phase 3 — User lie pour login driver (role DRIVER). NULL = driver "tag" sans login.';
COMMENT ON COLUMN "drivers"."licenseNumber" IS 'Numero de permis libre, usage interne — pas de validation officielle.';
COMMENT ON COLUMN "drivers"."color"       IS 'Couleur hex de pastille UI pour repere visuel.';

-- Vehicle.currentDriverId : conducteur "par defaut" du vehicule.
ALTER TABLE "vehicles"
  ADD COLUMN "currentDriverId" UUID;

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_currentDriverId_fkey"
  FOREIGN KEY ("currentDriverId") REFERENCES "drivers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "vehicles_currentDriverId_idx" ON "vehicles"("currentDriverId");

COMMENT ON COLUMN "vehicles"."currentDriverId" IS
  'Conducteur courant du vehicule. Snape sur Trip.driverId au finalize (driverSource=AUTO).';

-- Trip.driverId + driverSource : snapshot historique du conducteur.
ALTER TABLE "trips"
  ADD COLUMN "driverId"     UUID,
  ADD COLUMN "driverSource" TEXT;

ALTER TABLE "trips"
  ADD CONSTRAINT "trips_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "drivers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "trips_driverId_startedAt_idx" ON "trips"("driverId", "startedAt" DESC);

COMMENT ON COLUMN "trips"."driverId"     IS 'Conducteur snape sur ce trajet. Snape automatiquement depuis Vehicle.currentDriverId a la cloture.';
COMMENT ON COLUMN "trips"."driverSource" IS 'AUTO = snape automatique au finalize. MANUAL = modifie a posteriori.';
