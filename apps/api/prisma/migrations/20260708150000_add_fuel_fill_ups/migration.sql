-- Calibration carburant « méthode du plein » (2026-07) — pleins RENSEIGNÉS (litres réels) = vérité
-- terrain pour déduire la consommation RÉELLE d'un véhicule (litres/distance entre 2 pleins complets)
-- et fiabiliser tous les coûts. Indépendant de trip_fuel_stops (survit à la ré-analyse).
-- Migration HAND-WRITTEN (chirurgicale, anti-drift) : ne crée que cette table + sa FK vers fuel_stations.
CREATE TABLE "fuel_fill_ups" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "filledAt" TIMESTAMP(3) NOT NULL,
    "litersFilled" DOUBLE PRECISION NOT NULL,
    "amountPaidEur" DOUBLE PRECISION,
    "fullTank" BOOLEAN NOT NULL DEFAULT true,
    "odometerKm" DOUBLE PRECISION,
    "fuelType" TEXT,
    "stationId" UUID,
    "note" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fuel_fill_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fuel_fill_ups_vehicleId_filledAt_idx" ON "fuel_fill_ups"("vehicleId", "filledAt");
CREATE INDEX "fuel_fill_ups_fleetId_filledAt_idx" ON "fuel_fill_ups"("fleetId", "filledAt");

-- AddForeignKey
ALTER TABLE "fuel_fill_ups" ADD CONSTRAINT "fuel_fill_ups_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "fuel_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
