-- Taux de couverture des limites de vitesse sur une analyse de trajet.
--
-- `limitsKnown` ne répond qu'à « au moins UN point a-t-il obtenu une limite ? ». Un trajet
-- couvert à 2 % et un trajet couvert à 100 % lui répondaient tous deux oui, si bien qu'un
-- trajet dont presque rien n'a été confronté à une limite pouvait décrocher la meilleure note
-- par simple ignorance — et que rien ne permettait de retrouver les analyses à rejouer.
--
-- Le cas qui a ouvert le sujet (2026-09-03) : un point à 131 km/h réels n'a produit aucun excès
-- parce que sa limite de 110 km/h est entrée en cache LE LENDEMAIN du trajet. La donnée existe
-- désormais ; sans cette colonne, aucune requête ne peut retrouver l'analyse à recalculer.
--
-- NULL sur l'existant : une analyse d'avant cette mesure n'a pas de taux, et zéro serait faux.
ALTER TABLE "trip_analyses" ADD COLUMN "limitsCoverage" DOUBLE PRECISION;

-- Retrouver les analyses à rejouer se fait sur (couverture, date de calcul) : sans index, le
-- balayage horaire de l'automatisation ferait une lecture complète de la table.
CREATE INDEX "trip_analyses_limitsCoverage_computedAt_idx"
  ON "trip_analyses" ("limitsCoverage", "computedAt");
