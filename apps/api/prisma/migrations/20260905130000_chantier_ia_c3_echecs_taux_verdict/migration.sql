-- Chantier IA C3 (design/C3-CHANTIER-IA-2026-09-05.md) : échecs visibles, taux en base, verdict IA différé.
-- AlterTable
ALTER TABLE "ai_usage_logs" ADD COLUMN     "errorDetail" TEXT,
ADD COLUMN     "errorKind" TEXT,
ADD COLUMN     "estimatedCostUsd" DOUBLE PRECISION,
ADD COLUMN     "provider" TEXT;

-- AlterTable
ALTER TABLE "ai_budget" ADD COLUMN     "usdToEurRate" DOUBLE PRECISION NOT NULL DEFAULT 0.86;

-- AlterTable
ALTER TABLE "agenda_agent_proposals" ADD COLUMN     "aiKeep" BOOLEAN,
ADD COLUMN     "aiVerdictAt" TIMESTAMP(3);

-- ══ DONNÉES (point 4) ═══════════════════════════════════════════════════════════════════
-- Sonnet 5 était comptée 3/15 $ par million (le tarif de la hausse du 1er septembre, annulée par
-- Anthropic) : recalcul au tarif réel 2/10 (cache 2,50 / 0,20) depuis les jetons stockés — 26 lignes,
-- 0,891 $ → 0,594 $ mesurés en production le 2026-09-05. Seules les lignes API facturées bougent.
UPDATE "ai_usage_logs"
   SET "costUsd" = ("inputTokens" * 2 + "outputTokens" * 10 + "cacheWriteTokens" * 2.5 + "cacheReadTokens" * 0.2) / 1000000.0
 WHERE "executor" = 'api' AND "ok" = true AND "model" LIKE 'claude-sonnet-5%';

-- Doublons : chaque analyse de lieu livrée par le poste laissait DEUX lignes (courrier + serveur).
-- Celles du courrier n'ont ni société ni jeton ; le serveur garde la sienne (20 lignes en prod).
DELETE FROM "ai_usage_logs"
 WHERE "executor" = 'local' AND "action" = 'place_analysis' AND "fleetId" IS NULL
   AND "inputTokens" = 0 AND "outputTokens" = 0;

-- Fournisseur des lignes antérieures : déduit du modèle (les appels du poste sont Claude aussi).
UPDATE "ai_usage_logs" SET "provider" = CASE WHEN "model" LIKE 'gpt%' THEN 'gpt' ELSE 'claude' END
 WHERE "provider" IS NULL;
