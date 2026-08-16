-- Module « Communications » (2026-07) — visibilite admin de TOUT ce que Tracky envoie.
-- Deux manques comblés :
--   1. sms_logs n'avait pas de colonne modele : l'intention d'envoi etait noyee dans le
--      blob JSON `context` (3 conventions differentes), donc infiltrable/inagregeable.
--   2. les notifications push n'avaient AUCUN journal : les issues par appareil etaient
--      calculees puis jetees, seul un compteur agrege survivait. On ne pouvait donc pas
--      expliquer qu'un utilisateur « ne recoit plus rien » (abonnement expire 404/410).

-- AlterTable : modele d'envoi SMS (nullable — lignes historiques + SMS entrants).
ALTER TABLE "sms_logs" ADD COLUMN "template" TEXT;

-- CreateIndex
CREATE INDEX "sms_logs_template_createdAt_idx" ON "sms_logs"("template", "createdAt");

-- CreateEnum
CREATE TYPE "PushStatus" AS ENUM ('SENT', 'FAILED', 'EXPIRED');

-- CreateTable : journal des notifications push (1 ligne par appareil cible).
CREATE TABLE "push_logs" (
    "id" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "userId" UUID,
    "subscriptionId" UUID,
    "title" TEXT NOT NULL,
    "severity" TEXT,
    "status" "PushStatus" NOT NULL DEFAULT 'SENT',
    "statusCode" INTEGER,
    "errorMessage" TEXT,
    "fleetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_logs_template_createdAt_idx" ON "push_logs"("template", "createdAt");

-- CreateIndex
CREATE INDEX "push_logs_status_createdAt_idx" ON "push_logs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "push_logs_userId_idx" ON "push_logs"("userId");
