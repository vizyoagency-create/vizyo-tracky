-- TRK-056 — la cadence observee devient une MESURE et non un echantillon.
--
-- `currentFixIntervalS` valait l'ecart entre les deux dernieres trames. Sur un boitier qui
-- emet par salves (24,5 % des ecarts du parc sont sous 10 s), ce nombre est un tirage : le
-- 01/09, FM-772-JH affichait 2 s alors que la mediane de ses ecarts longs valait 47 s.
--
-- Cette colonne porte la fenetre glissante des 12 derniers ecarts. Ajout de colonne avec
-- valeur par defaut non volatile : operation de metadonnees en PostgreSQL, sans reecriture
-- de table — ce qui compte sur `trackers`, lue et ecrite a chaque trame.
ALTER TABLE "trackers"
  ADD COLUMN "recentFixIntervalsS" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
