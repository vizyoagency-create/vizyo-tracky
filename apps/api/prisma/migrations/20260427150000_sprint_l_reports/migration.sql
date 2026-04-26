-- V1.5 (Sprint L) — Rapports & export.
--
-- 1) Vehicle.fuelConsumptionL100km : estimation consommation par vehicule
--    (override le default par type CAR=7, TRUCK=22, etc.).
-- 2) Fleet.fuelPriceEurL : tarif litre essence (default 1.85 EUR/L).
-- 3) Fleet.weeklyReportEmail : email destinataire du rapport hebdo.

ALTER TABLE "vehicles"
  ADD COLUMN "fuelConsumptionL100km" DOUBLE PRECISION;

ALTER TABLE "fleets"
  ADD COLUMN "fuelPriceEurL"     DOUBLE PRECISION NOT NULL DEFAULT 1.85,
  ADD COLUMN "weeklyReportEmail" TEXT;
