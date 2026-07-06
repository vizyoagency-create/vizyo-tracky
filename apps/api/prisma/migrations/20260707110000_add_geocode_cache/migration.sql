-- Refonte agenda/IA (2026-07, P3) — Cache de géocodage inverse (Nominatim/OSM).
-- Nomme un point d'arrivée récurrent sans re-taper l'API à chaque analyse nocturne.

-- CreateTable
CREATE TABLE "geocode_cache" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "geocode_cache_key_key" ON "geocode_cache"("key");
