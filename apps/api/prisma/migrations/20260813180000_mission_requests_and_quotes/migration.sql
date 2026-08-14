-- CreateEnum
CREATE TYPE "MissionRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'NEGOTIATING', 'ACCEPTED', 'CONVERTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MissionStopKind" AS ENUM ('PICKUP', 'DROPOFF');

-- CreateEnum
CREATE TYPE "QuoteRoundAuthor" AS ENUM ('SYSTEM', 'DEPOT', 'CARRIER');

-- CreateTable
CREATE TABLE "mission_requests" (
    "id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "fleetId" UUID NOT NULL,
    "depotUserId" UUID NOT NULL,
    "status" "MissionRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "wantedStartAt" TIMESTAMP(3) NOT NULL,
    "wantedEndAt" TIMESTAMP(3) NOT NULL,
    "goodsDescription" TEXT,
    "weightKg" INTEGER,
    "vehicleType" "VehicleType",
    "declaredDistanceM" INTEGER,
    "estimatedDistanceM" INTEGER,
    "usedDistanceM" INTEGER,
    "agreedAmountCents" INTEGER,
    "agreedAt" TIMESTAMP(3),
    "quoteExpiresAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "rejectedBy" "QuoteRoundAuthor",
    "missionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mission_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_stops" (
    "id" UUID NOT NULL,
    "requestId" UUID,
    "missionId" UUID,
    "position" INTEGER NOT NULL,
    "kind" "MissionStopKind" NOT NULL DEFAULT 'DROPOFF',
    "label" TEXT NOT NULL,
    "placeId" UUID,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "wantedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_quote_rounds" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "author" "QuoteRoundAuthor" NOT NULL,
    "authorUserId" UUID,
    "amountCents" INTEGER,
    "terms" JSONB NOT NULL,
    "breakdown" JSONB,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_quote_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_pricing_settings" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "extraStopCents" INTEGER NOT NULL DEFAULT 0,
    "waitingHourCents" INTEGER NOT NULL DEFAULT 0,
    "vatPct" INTEGER NOT NULL DEFAULT 20,
    "quoteValidityHours" INTEGER NOT NULL DEFAULT 48,
    "quoteFooterNote" TEXT,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mission_pricing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_pricing_tiers" (
    "id" UUID NOT NULL,
    "settingsId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "fromKm" INTEGER NOT NULL,
    "toKm" INTEGER,
    "priceCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mission_pricing_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mission_requests_missionId_key" ON "mission_requests"("missionId");

-- CreateIndex
CREATE INDEX "mission_requests_fleetId_status_createdAt_idx" ON "mission_requests"("fleetId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "mission_requests_depotUserId_createdAt_idx" ON "mission_requests"("depotUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "mission_requests_fleetId_ref_key" ON "mission_requests"("fleetId", "ref");

-- CreateIndex
CREATE INDEX "mission_stops_requestId_idx" ON "mission_stops"("requestId");

-- CreateIndex
CREATE INDEX "mission_stops_missionId_idx" ON "mission_stops"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "mission_stops_requestId_position_key" ON "mission_stops"("requestId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "mission_stops_missionId_position_key" ON "mission_stops"("missionId", "position");

-- CreateIndex
CREATE INDEX "mission_quote_rounds_requestId_position_idx" ON "mission_quote_rounds"("requestId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "mission_quote_rounds_requestId_position_key" ON "mission_quote_rounds"("requestId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "mission_pricing_settings_fleetId_key" ON "mission_pricing_settings"("fleetId");

-- CreateIndex
CREATE INDEX "mission_pricing_tiers_settingsId_category_fromKm_idx" ON "mission_pricing_tiers"("settingsId", "category", "fromKm");

-- CreateIndex
CREATE UNIQUE INDEX "mission_pricing_tiers_settingsId_category_position_key" ON "mission_pricing_tiers"("settingsId", "category", "position");

-- AddForeignKey
ALTER TABLE "mission_requests" ADD CONSTRAINT "mission_requests_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_requests" ADD CONSTRAINT "mission_requests_depotUserId_fkey" FOREIGN KEY ("depotUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_requests" ADD CONSTRAINT "mission_requests_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_stops" ADD CONSTRAINT "mission_stops_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "mission_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_stops" ADD CONSTRAINT "mission_stops_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_stops" ADD CONSTRAINT "mission_stops_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "fleet_places"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_quote_rounds" ADD CONSTRAINT "mission_quote_rounds_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "mission_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_pricing_settings" ADD CONSTRAINT "mission_pricing_settings_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_pricing_tiers" ADD CONSTRAINT "mission_pricing_tiers_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "mission_pricing_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════
--  COMPLÉMENTS ÉCRITS À LA MAIN
--  Le SQL ci-dessus est généré. Ce qui suit ne l'est pas, et ne doit pas être perdu
--  si la migration est régénérée un jour.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. UN ARRÊT APPARTIENT À UNE DEMANDE *OU* À UNE MISSION, JAMAIS AUX DEUX ──
-- Prisma ne sait pas exprimer un « exactement un parmi deux » : sans cette
-- contrainte, un arrêt orphelin (les deux nuls) ou schizophrène (les deux remplis)
-- serait accepté par la base, et le bogue ne se verrait qu'à la lecture.
ALTER TABLE "mission_stops"
  ADD CONSTRAINT "mission_stops_un_seul_parent"
  CHECK (("requestId" IS NOT NULL AND "missionId" IS NULL)
      OR ("requestId" IS NULL AND "missionId" IS NOT NULL));

-- ── 2. LA GRILLE PAR DÉFAUT ───────────────────────────────────────────────────
-- Le client fournit cette grille comme tarif de référence (« normalement elle est
-- remplie par défaut »). On l'écrit pour chaque société existante.
--
-- ⚠️ `enabled = true` : la tarification est ACTIVE dès la migration. C'est ce que
-- le client demande, et l'arbitrage J la rend sans danger — une grille inadaptée se
-- corrige ou se désactive depuis l'écran Paramètres, et aucune mission n'est
-- bloquée entre-temps.
INSERT INTO "mission_pricing_settings"
  ("id", "fleetId", "enabled", "vatPct", "quoteValidityHours",
   "extraStopCents", "waitingHourCents", "createdAt", "updatedAt")
SELECT gen_random_uuid(), f."id", true, 20, 48, 0, 0, NOW(), NOW()
FROM "fleets" f;

-- Les tranches. Bornes en kilomètres, INCLUSES.
--
-- ⚠️ RÈGLE DE SÉLECTION, à respecter dans le moteur de devis : la tranche retenue
-- est LA PREMIÈRE, par ordre croissant, dont `toKm` est supérieur ou égal à la
-- distance — ou dont `toKm` est nul. Et non un encadrement [fromKm, toKm] : la
-- grille du client saute de « 0 à 50 » à « 51 à 100 », ce qui laisserait 50,4 km
-- sans tranche. `fromKm` est là pour l'affichage, `toKm` pour la décision.
--
-- La dernière ligne porte `priceCents` NUL : c'est « Sur devis », pas un prix.
INSERT INTO "mission_pricing_tiers"
  ("id", "settingsId", "category", "position", "fromKm", "toKm", "priceCents",
   "createdAt", "updatedAt")
SELECT gen_random_uuid(), s."id", 'Transport de marchandise',
       t.position, t.from_km, t.to_km, t.price_cents, NOW(), NOW()
FROM "mission_pricing_settings" s
CROSS JOIN (VALUES
  (0,   0,   50::int,  7900::int),
  (1,  51,  100,       16900),
  (2, 101,  150,       25900),
  (3, 151,  200,       34900),
  (4, 201,  250,       44900),
  (5, 251,  300,       53900),
  (6, 301,  350,       62900),
  (7, 351,  400,       71900),
  (8, 401,  NULL,      NULL)
) AS t(position, from_km, to_km, price_cents);
