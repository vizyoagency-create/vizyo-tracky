-- Calibration carburant (2026-07) — consommation RÉELLE calibrée (méthode du plein) stockée sur le
-- véhicule : recalculée à chaque plein renseigné, elle PRIME sur fuelConsumptionL100km partout
-- (rapports/PDF/Excel/fuel card) pour fiabiliser coûts & conso. calibratedTanks = nb de réservoirs
-- mesurés (confiance). Migration HAND-WRITTEN (chirurgicale) : n'ajoute que ces 3 colonnes.
ALTER TABLE "vehicles" ADD COLUMN "calibratedConsumptionL100km" DOUBLE PRECISION;
ALTER TABLE "vehicles" ADD COLUMN "calibratedTanks" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "vehicles" ADD COLUMN "calibratedAt" TIMESTAMP(3);
