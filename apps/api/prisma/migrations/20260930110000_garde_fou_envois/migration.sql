-- 30/09 — garde-fou d'envoi : un courriel RETENU se journalise (rien n'est parti),
-- et une société peut être mise en « mode recette » (avis retenus jusqu'à une heure donnée).

-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "fleets" ADD COLUMN     "envoisSuspendusJusqua" TIMESTAMP(3);
