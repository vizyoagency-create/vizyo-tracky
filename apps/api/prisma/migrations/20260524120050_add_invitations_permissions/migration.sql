-- V1.11 Phase 1 — Fix de migration manquante : la colonne `permissions` etait
-- presente dans le schema Prisma (Invitation.permissions Json?) et utilisee
-- dans le code (commit 8ab45b7), mais aucune migration historique ne l'a
-- ajoutee a la table. Ce fichier comble ce trou avant l'execution du backfill.

ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "permissions" JSONB;
