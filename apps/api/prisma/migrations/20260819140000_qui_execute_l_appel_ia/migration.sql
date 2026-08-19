-- Qui a REELLEMENT execute l'appel IA : `api` (credits Anthropic, factures) ou `local`
-- (agent sur le poste du proprietaire, absorbe par l'abonnement Claude Code).
--
-- Sans ce champ, un agent local travaillerait sans laisser de trace dans les ecrans de couts :
-- le travail disparaitrait des tableaux au moment meme ou il cesse d'etre facture.
--
-- Defaut `api`, NOT NULL : toutes les lignes existantes ont bien ete facturees par l'API, aucun
-- autre executant n'existait a l'epoque. Le defaut enonce un fait vrai, il n'en invente pas.
ALTER TABLE "ai_usage_logs" ADD COLUMN "executor" TEXT NOT NULL DEFAULT 'api';
