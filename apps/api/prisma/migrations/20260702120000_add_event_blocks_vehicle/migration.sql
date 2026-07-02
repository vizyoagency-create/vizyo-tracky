-- Immobilisation : un incident/maintenance peut rendre le véhicule indisponible
-- (exclu des suggestions et des réservations tant que l'événement est actif).
ALTER TABLE "vehicle_events" ADD COLUMN "blocksVehicle" BOOLEAN NOT NULL DEFAULT false;
