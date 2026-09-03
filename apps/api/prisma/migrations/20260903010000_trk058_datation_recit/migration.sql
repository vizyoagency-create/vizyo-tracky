-- Datation du RÉCIT, distincte de celle des chiffres.
--
-- Un recalcul d'analyse (`POST /api/trip-analysis/:tripId`) remplace toutes les mesures et
-- conserve le récit : le texte pouvait donc décrire un trajet qui n'existe plus sous cette
-- forme, sans que rien ne le signale. `computedAt` date les chiffres, `updatedAt` la ligne ;
-- il manquait la date du texte.
--
-- Reprise des lignes existantes : les récits déjà écrits sont datés de `computedAt`, ce qui
-- est vrai pour l'immense majorité (l'agent écrit le récit dans la foulée de l'analyse) et
-- ne crée aucun faux signal « récit périmé » sur l'existant.
ALTER TABLE "trip_analyses" ADD COLUMN "narratedAt" TIMESTAMP(3);

UPDATE "trip_analyses" SET "narratedAt" = "computedAt" WHERE "narrative" IS NOT NULL;
