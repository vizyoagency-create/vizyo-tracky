-- La note de conduite peut ne pas être calculable.
--
-- Elle valait 100 EN DUR sur une analyse sans aucune position exploitable : un trajet dont on
-- ne savait rien décrochait la note maximale, et remontait au classement précisément parce
-- qu'il était mal suivi. Le correctif du 3 septembre avait écarté ces analyses de la moyenne,
-- ce qui traitait le symptôme ; la valeur 100 restait écrite en base et s'affichait sur la fiche
-- du trajet.
--
-- Une note absente est une information. Une note inventée n'en est pas une.
ALTER TABLE "trip_analyses" ALTER COLUMN "ecoScore" DROP NOT NULL;

-- Reprise de l'existant : les analyses SANS aucune position exploitable perdent leur 100 inventé.
-- Les autres gardent leur note, qui sera recalculée par le rejeu de l'automatisation.
UPDATE "trip_analyses" SET "ecoScore" = NULL WHERE "gpsPoints" = 0;
