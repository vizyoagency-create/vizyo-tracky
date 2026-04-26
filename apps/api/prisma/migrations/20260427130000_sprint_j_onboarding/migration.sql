-- V1.5 (Sprint J) — Onboarding UX + invitations utilisateur.
--
-- 1) User enrichi : phone (E.164), onboardingCompletedAt, escalationContactUserId
-- 2) Table invitations (state machine PENDING -> ACCEPTED / EXPIRED / REVOKED)

ALTER TABLE "users"
  ADD COLUMN "phone"                   TEXT,
  ADD COLUMN "onboardingCompletedAt"   TIMESTAMP(3),
  ADD COLUMN "escalationContactUserId" UUID;

ALTER TABLE "users"
  ADD CONSTRAINT "users_escalationContactUserId_fkey"
  FOREIGN KEY ("escalationContactUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "invitations" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "email"       TEXT NOT NULL,
  "role"        "UserRole" NOT NULL,
  "fleetId"     UUID,
  "tokenHash"   TEXT NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'PENDING',
  "createdById" UUID NOT NULL,
  "acceptedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");
CREATE INDEX "invitations_email_idx" ON "invitations"("email");
CREATE INDEX "invitations_status_idx" ON "invitations"("status");

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
