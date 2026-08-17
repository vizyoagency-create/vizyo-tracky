-- TRK-028 — le RETOUR du signal, pas seulement sa perte.
--
-- `gps_loss_events` n'enregistrait que l'entree en zone morte : on savait qu'un vehicule
-- avait perdu le GPS quelque part, jamais qu'il l'avait retrouve. La fiche vehicule
-- pouvait donc affirmer « la position reapparaitra a la sortie » sans jamais pouvoir le
-- MONTRER — une promesse sans preuve.
--
-- NULLABLE et sans valeur par defaut, volontairement : NULL signifie « episode encore
-- ouvert », et c'est aussi l'etat des 27 lignes historiques, dont personne n'a observe
-- la sortie. Les remplir d'une date inventee fabriquerait des durees fausses qui
-- alimenteraient ensuite la moyenne affichee.
ALTER TABLE "gps_loss_events" ADD COLUMN "recoveredAt" TIMESTAMP(3);

-- L'index porte sur le couple, pas sur la seule colonne : la requete du chemin
-- d'ingestion est « les episodes ouverts DE CE VEHICULE ». Elle s'execute a chaque
-- position valide qui suit un long silence, et doit rester en O(1).
CREATE INDEX "gps_loss_events_vehicleId_recoveredAt_idx" ON "gps_loss_events"("vehicleId", "recoveredAt");