-- CreateEnum
CREATE TYPE "PartnerLinkStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateTable
CREATE TABLE "partner_links" (
    "id" UUID NOT NULL,
    "fleetId" UUID NOT NULL,
    "partner" TEXT NOT NULL,
    "externalOrgId" TEXT NOT NULL,
    "externalOrgName" TEXT NOT NULL,
    "externalOrgSiret" TEXT,
    "status" "PartnerLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "liveKey" TEXT,
    "billingStatus" TEXT NOT NULL DEFAULT 'COMP',
    "suspendedByPlatform" BOOLEAN NOT NULL DEFAULT false,
    "suspendedReason" TEXT,
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "secretHash" TEXT NOT NULL,
    "secretRotatedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "approvedByUserId" UUID,
    "approvedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_link_events" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" UUID,
    "scope" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_link_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_access_tokens" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_outbox_events" (
    "id" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_links_fleetId_idx" ON "partner_links"("fleetId");

-- CreateIndex
CREATE INDEX "partner_links_status_idx" ON "partner_links"("status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_links_fleetId_liveKey_key" ON "partner_links"("fleetId", "liveKey");

-- CreateIndex
CREATE UNIQUE INDEX "partner_links_externalOrgId_liveKey_key" ON "partner_links"("externalOrgId", "liveKey");

-- CreateIndex
CREATE INDEX "partner_link_events_linkId_createdAt_idx" ON "partner_link_events"("linkId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "partner_access_tokens_tokenHash_key" ON "partner_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "partner_access_tokens_linkId_expiresAt_idx" ON "partner_access_tokens"("linkId", "expiresAt");

-- CreateIndex
CREATE INDEX "partner_outbox_events_deliveredAt_nextAttemptAt_idx" ON "partner_outbox_events"("deliveredAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "partner_outbox_events_linkId_idx" ON "partner_outbox_events"("linkId");

-- AddForeignKey
ALTER TABLE "partner_links" ADD CONSTRAINT "partner_links_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "fleets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_link_events" ADD CONSTRAINT "partner_link_events_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "partner_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_access_tokens" ADD CONSTRAINT "partner_access_tokens_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "partner_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_outbox_events" ADD CONSTRAINT "partner_outbox_events_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "partner_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

