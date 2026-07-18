-- Analyse IA d'un lieu cle. UNE analyse courante par lieu (unique placeId) : re-analyser remplace.
-- `facts` fige les donnees sources (OSM + agregats flotte) pour pouvoir verifier a posteriori d'ou
-- sort une affirmation — l'IA REFORMULE des faits, elle n'en invente pas.
-- placeId / fleetId / computedByUserId denormalises (pas de FK), meme convention que fleet_places.

CREATE TABLE "place_analyses" (
    "id" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "facts" JSONB,
    "summary" TEXT NOT NULL,
    "highlights" JSONB NOT NULL,
    "recommendations" JSONB NOT NULL,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "costEur" DOUBLE PRECISION,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "computedByUserId" UUID,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "place_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex : une seule analyse courante par lieu.
CREATE UNIQUE INDEX "place_analyses_placeId_key" ON "place_analyses"("placeId");

-- CreateIndex
CREATE INDEX "place_analyses_fleetId_computedAt_idx" ON "place_analyses"("fleetId", "computedAt");
