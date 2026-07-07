-- Traçabilité fine des trajets (Palier 2) — analyse déterministe persistée + cache limites OSM.
-- Migration HAND-WRITTEN (chirurgicale) : ne touche QUE les 2 nouvelles tables (évite le drift que
-- `prisma migrate dev` embarquerait depuis une base de dev en retard sur le schéma).

-- CreateTable
CREATE TABLE "trip_analyses" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "movingSec" INTEGER NOT NULL,
    "avgSpeedKmh" DOUBLE PRECISION NOT NULL,
    "maxSpeedKmh" DOUBLE PRECISION NOT NULL,
    "stopCount" INTEGER NOT NULL,
    "idleSec" INTEGER NOT NULL,
    "gpsPoints" INTEGER NOT NULL,
    "gpsValidRatio" DOUBLE PRECISION NOT NULL,
    "gpsLostCount" INTEGER NOT NULL,
    "speedingCount" INTEGER NOT NULL,
    "speedingSec" INTEGER NOT NULL,
    "maxOverKmh" DOUBLE PRECISION NOT NULL,
    "limitsKnown" BOOLEAN NOT NULL DEFAULT false,
    "harshAccel" INTEGER NOT NULL,
    "harshBrake" INTEGER NOT NULL,
    "ecoScore" INTEGER NOT NULL,
    "fuelLiters" DOUBLE PRECISION,
    "co2Kg" DOUBLE PRECISION,
    "detail" JSONB NOT NULL,
    "provider" TEXT,
    "narrative" TEXT,
    "advice" TEXT,
    "trustScore" INTEGER,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trip_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trip_analyses_tripId_key" ON "trip_analyses"("tripId");
CREATE INDEX "trip_analyses_vehicleId_computedAt_idx" ON "trip_analyses"("vehicleId", "computedAt");
CREATE INDEX "trip_analyses_fleetId_computedAt_idx" ON "trip_analyses"("fleetId", "computedAt");

-- CreateTable
CREATE TABLE "speed_limit_cache" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "maxspeed" INTEGER,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speed_limit_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "speed_limit_cache_key_key" ON "speed_limit_cache"("key");
