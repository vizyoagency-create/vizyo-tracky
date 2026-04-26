-- V1.5 (Sprint M) — Alertes avancees : Web Push + Email + WhatsApp + escalade.
--
-- 1) push_subscriptions : 1 ligne par device/browser abonne au push.
-- 2) alert_rules        : regles personnalisables par fleet (et optionnellement
--    par vehicule + type), avec channels actifs et escalade.
-- 3) alerts.escalatedAt : timestamp de l'escalade automatique (idempotent).

CREATE TABLE "push_subscriptions" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"     UUID NOT NULL,
  "endpoint"   TEXT NOT NULL,
  "p256dh"     TEXT NOT NULL,
  "auth"       TEXT NOT NULL,
  "userAgent"  TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

CREATE TABLE "alert_rules" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "fleetId"          UUID NOT NULL,
  "vehicleId"        UUID,
  "alertType"        TEXT NOT NULL,
  "enabled"          BOOLEAN NOT NULL DEFAULT true,
  "channels"         JSONB NOT NULL DEFAULT '[]'::jsonb,
  "escalateAfterMin" INTEGER,
  "escalateToUserId" UUID,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alert_rules_fleetId_idx" ON "alert_rules"("fleetId");
CREATE INDEX "alert_rules_vehicleId_idx" ON "alert_rules"("vehicleId");
CREATE INDEX "alert_rules_alertType_idx" ON "alert_rules"("alertType");

ALTER TABLE "alerts"
  ADD COLUMN "escalatedAt" TIMESTAMP(3);
