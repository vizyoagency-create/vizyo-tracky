-- TRK-030 : distinguer une coupure d'alimentation reelle d'un simple contact coupe.
--
-- Quand la batterie interne est pleine, l'absence d'alimentation externe n'est pas une
-- panne : c'est un boitier cable sur du +12V commute, contact coupe. On cesse d'alerter,
-- mais on GARDE la trace ici — sinon on remplacerait 202 fausses alertes par un silence
-- tout aussi trompeur.
--
-- Nullable et sans defaut : NULL = jamais observe, ce qui est l'etat honnete des lignes
-- existantes.
ALTER TABLE "trackers" ADD COLUMN "lastPowerNoticeAt" TIMESTAMP(3);
ALTER TABLE "trackers" ADD COLUMN "lastPowerNotice" TEXT;
