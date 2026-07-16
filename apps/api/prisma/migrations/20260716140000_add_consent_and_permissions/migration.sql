-- RGPD — consentements & permissions.
-- • user_consents : preuve de consentement d'un utilisateur (CGU / Confidentialité),
--   versionnée + horodatée + IP/userAgent. Le gate d'accès (403 CONSENT_REQUIRED)
--   compare CONSENT_VERSION à la dernière version acceptée.
-- • lp_consents : choix accepter/refuser d'un VISITEUR LP (anonyme), avec IP.
-- • user_permissions : permission device (notifications / localisation) par appareil.
-- • push_subscriptions.label : nom lisible de l'appareil (gestion/révocation).
-- Migration écrite à la main (comme les autres — évite le drift d'une base de dev
-- en retard). Tables neuves + colonne nullable : sûr sur les lignes existantes.

-- AlterTable
ALTER TABLE "push_subscriptions" ADD COLUMN "label" TEXT;

-- CreateTable
CREATE TABLE "user_consents" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "docType" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL DEFAULT true,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_consents_userId_docType_idx" ON "user_consents"("userId", "docType");

-- CreateTable
CREATE TABLE "lp_consents" (
    "id" UUID NOT NULL,
    "sessionId" TEXT,
    "choice" TEXT NOT NULL,
    "categories" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "page" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lp_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lp_consents_createdAt_idx" ON "lp_consents"("createdAt");

-- CreateTable
CREATE TABLE "user_permissions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT,
    "kind" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_permissions_userId_deviceId_kind_key" ON "user_permissions"("userId", "deviceId", "kind");

-- CreateIndex
CREATE INDEX "user_permissions_userId_idx" ON "user_permissions"("userId");

-- AddForeignKey
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
