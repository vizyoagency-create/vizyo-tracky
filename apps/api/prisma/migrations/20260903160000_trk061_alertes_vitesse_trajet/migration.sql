-- TRK-061 (lot V5, 2026-09-03) — alertes de vitesse nées de l'analyse de trajet.
--
-- 1. L'alerte porte son trajet : c'est ce lien qui permet au clic sur la notification
--    d'ouvrir le trajet, et à la déduplication de raisonner par trajet.
ALTER TABLE "alerts" ADD COLUMN "tripId" UUID;
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "alerts_tripId_idx" ON "alerts"("tripId");

-- 2. Réglage par société — OPT-IN : défaut coupé, aucune société n'est arrosée au déploiement.
ALTER TABLE "fleets"
  ADD COLUMN "speedAlertEnabled"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "speedAlertOverKmh"     INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "speedAlertAbsoluteKmh" INTEGER DEFAULT 130,
  ADD COLUMN "speedAlertUpdatedAt"   TIMESTAMP(3),
  ADD COLUMN "speedAlertUpdatedById" UUID;

-- 3. Surcharge par véhicule (nul = hérite de la société).
ALTER TABLE "vehicles"
  ADD COLUMN "speedAlertEnabled" BOOLEAN,
  ADD COLUMN "speedAlertOverKmh" INTEGER;
