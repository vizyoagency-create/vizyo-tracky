-- SÉCURITÉ — 2FA app OPT-IN par utilisateur + historique de connexions (adaptatif).
-- • users.twoFactorEnabled / twoFactorPromptedAt / twoFactorPromptDismissed : opt-in
--   2FA par utilisateur (jamais imposé).
-- • trusted_devices : appareils de confiance (userId, deviceId).
-- • login_events : journal des connexions (appareil + position géo-IP ville/région +
--   signaux d'anomalie). Socle de la détection adaptative + carte admin.
-- Migration écrite à la main. Colonnes NOT NULL avec DEFAULT + tables neuves : sûr
-- sur les lignes existantes.

-- AlterTable (users) — opt-in 2FA
ALTER TABLE "users" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "twoFactorPromptedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "twoFactorPromptDismissed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable trusted_devices
CREATE TABLE "trusted_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "label" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "trustedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trusted_devices_userId_deviceId_key" ON "trusted_devices"("userId", "deviceId");
CREATE INDEX "trusted_devices_userId_idx" ON "trusted_devices"("userId");

-- AddForeignKey
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable login_events
CREATE TABLE "login_events" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT,
    "ip" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "userAgent" TEXT,
    "newDevice" BOOLEAN NOT NULL DEFAULT false,
    "farFromUsual" BOOLEAN NOT NULL DEFAULT false,
    "challenged" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_events_userId_createdAt_idx" ON "login_events"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
