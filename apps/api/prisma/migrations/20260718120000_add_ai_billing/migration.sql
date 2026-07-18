-- Facturation (2026-07-18) — option IA PAYANTE via Stripe.
-- Migration HAND-WRITTEN (chirurgicale, anti-drift) : abonnement IA par societe + reglages de prix.

-- Statut de l'abonnement IA d'une societe (pilote Fleet.aiEnabled).
CREATE TYPE "AiSubscriptionStatus" AS ENUM ('NONE', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INVOICE_PENDING', 'COMP');

-- Client Stripe de la societe (cree a la 1re carte / au 1er abonnement).
ALTER TABLE "fleets" ADD COLUMN "stripeCustomerId" TEXT;

-- Abonnement a l'option IA (1:1 fleet).
CREATE TABLE "ai_subscriptions" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "status" "AiSubscriptionStatus" NOT NULL DEFAULT 'NONE',
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "unitAmountEurCents" INTEGER,
    "quantity" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "compedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_subscriptions_fleetId_key" ON "ai_subscriptions"("fleetId");
CREATE UNIQUE INDEX "ai_subscriptions_stripeSubscriptionId_key" ON "ai_subscriptions"("stripeSubscriptionId");

ALTER TABLE "ai_subscriptions" ADD CONSTRAINT "ai_subscriptions_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reglages de facturation (SINGLETON) — prix de l'option IA configurable par le super-admin.
CREATE TABLE "billing_settings" (
    "id" UUID NOT NULL,
    "aiUnitAmountEurCents" INTEGER NOT NULL DEFAULT 500,
    "aiPricingUnit" TEXT NOT NULL DEFAULT 'per_vehicle',
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("id")
);
