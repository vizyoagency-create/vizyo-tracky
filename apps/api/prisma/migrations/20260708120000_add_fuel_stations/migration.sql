-- Stations-service & prix carburants (2026-07) — détection des passages en station sur les trajets
-- (arrêts tombant sur une station), historisation des prix (API officielle FR prix-carburants) et
-- estimation des coûts. Migration HAND-WRITTEN (chirurgicale) : ne crée QUE les 3 nouvelles tables
-- (évite le drift que `prisma migrate dev` embarquerait depuis une base de dev en retard sur le schéma).

-- CreateTable
CREATE TABLE "fuel_stations" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "brand" TEXT,
    "name" TEXT,
    "address" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fuel_stations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fuel_stations_source_externalId_key" ON "fuel_stations"("source", "externalId");
CREATE INDEX "fuel_stations_lat_lng_idx" ON "fuel_stations"("lat", "lng");

-- CreateTable
CREATE TABLE "fuel_station_prices" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "fuelType" TEXT NOT NULL,
    "priceEur" DOUBLE PRECISION NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fuel_station_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fuel_station_prices_stationId_fuelType_sourceUpdatedAt_key" ON "fuel_station_prices"("stationId", "fuelType", "sourceUpdatedAt");
CREATE INDEX "fuel_station_prices_stationId_fuelType_capturedAt_idx" ON "fuel_station_prices"("stationId", "fuelType", "capturedAt");

-- CreateTable
CREATE TABLE "trip_fuel_stops" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "arrivedAt" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "distanceM" DOUBLE PRECISION NOT NULL,
    "fuelType" TEXT,
    "unitPriceEur" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_fuel_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_fuel_stops_vehicleId_arrivedAt_idx" ON "trip_fuel_stops"("vehicleId", "arrivedAt");
CREATE INDEX "trip_fuel_stops_fleetId_arrivedAt_idx" ON "trip_fuel_stops"("fleetId", "arrivedAt");
CREATE INDEX "trip_fuel_stops_tripId_idx" ON "trip_fuel_stops"("tripId");

-- AddForeignKey
ALTER TABLE "fuel_station_prices" ADD CONSTRAINT "fuel_station_prices_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "fuel_stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_fuel_stops" ADD CONSTRAINT "trip_fuel_stops_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "fuel_stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
