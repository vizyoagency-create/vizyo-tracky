-- D4 + Phase 3 (chantier commercial 2026-07) — abonnements clients & grille tarifaire.
-- Plans (repositionnement tout inclus) : LITE / PRO / SIGNATURE ; formules SERENITE / LIBERTE.

-- CreateEnum
CREATE TYPE "TrackyPlan" AS ENUM ('LITE', 'PRO', 'SIGNATURE');
CREATE TYPE "TrackyFormule" AS ENUM ('SERENITE', 'LIBERTE');

-- CreateTable : abonnement commercial par flotte (1:1).
CREATE TABLE "fleet_subscriptions" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "plan" "TrackyPlan" NOT NULL DEFAULT 'PRO',
    "formule" "TrackyFormule" NOT NULL DEFAULT 'SERENITE',
    "optLive" BOOLEAN NOT NULL DEFAULT false,
    "optMicro" BOOLEAN NOT NULL DEFAULT false,
    "optAgent" BOOLEAN NOT NULL DEFAULT false,
    "retentionKey" TEXT NOT NULL DEFAULT '90j',
    "isComp" BOOLEAN NOT NULL DEFAULT false,
    "customPriceEurYear" INTEGER,
    "notes" TEXT,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fleet_subscriptions_fleetId_key" ON "fleet_subscriptions"("fleetId");

ALTER TABLE "fleet_subscriptions" ADD CONSTRAINT "fleet_subscriptions_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable : grille tarifaire publique (singleton, JSON forme pricing.mjs).
CREATE TABLE "pricing_settings" (
    "id" UUID NOT NULL,
    "grid" JSONB NOT NULL,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_settings_pkey" PRIMARY KEY ("id")
);
