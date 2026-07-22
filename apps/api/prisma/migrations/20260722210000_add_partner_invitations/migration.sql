-- Invitation à consentir (e-mail → écran de consentement) + preuve RGPD.
--
-- ⚠️ SQL produit par `prisma migrate diff --from-migrations --to-schema-datamodel`,
-- dont SEUL le bloc `partner_invitations` a été conservé. Le diff complet
-- embarquait une DÉRIVE PRÉEXISTANTE de l'historique (5 valeurs `AlertType` et
-- une trentaine de `ALTER COLUMN "id" DROP DEFAULT`) : ces colonnes ont un
-- `gen_random_uuid()` côté base que le schéma déclare désormais côté client.
-- Les retirer casserait tout INSERT SQL brut, et ce n'est de toute façon pas le
-- sujet de cette migration. À traiter séparément, en connaissance de cause.

-- CreateTable
CREATE TABLE "partner_invitations" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "partner" TEXT NOT NULL,
    "pairingCode" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "sentByUserId" UUID,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "openIp" TEXT,
    "openUserAgent" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" UUID,
    "acceptedScopes" JSONB NOT NULL DEFAULT '[]',
    "linkId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_invitations_token_key" ON "partner_invitations"("token");

-- CreateIndex
CREATE INDEX "partner_invitations_partner_pairingCode_idx" ON "partner_invitations"("partner", "pairingCode");

-- CreateIndex
CREATE INDEX "partner_invitations_fleetId_sentAt_idx" ON "partner_invitations"("fleetId", "sentAt" DESC);

-- AddForeignKey
ALTER TABLE "partner_invitations" ADD CONSTRAINT "partner_invitations_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
