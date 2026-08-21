-- File de travaux IA executes sur le poste du proprietaire (cf. design/C1-TRAVAUX-IA-LOCAUX.md).
--
-- Pourquoi cette table existe : deux services IA recurrents (rapport d'activite hebdomadaire,
-- analyse de lieux) etaient COUPES faute d'un cout d'API justifiable. L'abonnement du poste les
-- rend gratuits, mais leur preparation de donnees est trop imbriquee dans le serveur pour etre
-- extraite en module pur — la recopier dans un agent aurait garanti la divergence.
--
-- D'ou la file : le SERVEUR prepare le travail complet (prompt systeme, schema JSON, donnees)
-- et le range ici ; l'agent du poste n'est qu'un COURRIER — il lit, appelle le modele, ecrit
-- `resultat`, et ne touche a rien d'autre ; le serveur valide et persiste avec ses fonctions
-- existantes. Aucune logique metier ne quitte le serveur.
CREATE TABLE "travaux_ia_locaux" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    -- 'rapport-activite' | 'analyse-lieu' | tout futur type : l'agent n'en connait aucun.
    "type" TEXT NOT NULL,
    -- a-faire -> pris -> fait -> (consomme = ligne effacee) ; echec apres 3 tentatives.
    "statut" TEXT NOT NULL DEFAULT 'a-faire',
    -- { system, schema, userPayload, maxTokens } : TOUT ce qu'il faut pour l'appel modele.
    "payload" JSONB NOT NULL,
    -- Ce que le CONSOMMATEUR serveur doit savoir pour persister (ids, periode, titre...).
    "contexte" JSONB NOT NULL,
    "resultat" JSONB,
    "erreur" TEXT,
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "creeA" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prisA" TIMESTAMP(3),
    "finiA" TIMESTAMP(3),

    CONSTRAINT "travaux_ia_locaux_pkey" PRIMARY KEY ("id")
);

-- Le courrier et le consommateur interrogent toujours par (statut, type).
CREATE INDEX "travaux_ia_locaux_statut_type_idx" ON "travaux_ia_locaux"("statut", "type");
