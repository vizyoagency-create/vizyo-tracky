-- JAMAIS LE JOUR MEME : LE PREMIER JOUR PROPOSE EST J+1 (decision du proprietaire, 2026-09-14).
--
-- `leadHours` (delai en heures) laissait reserver le jour meme des que le delai etait court, et,
-- a 24 h, faisait disparaitre le matin du lendemain des l'apres-midi. La regle voulue est en
-- jours entiers : le lendemain, tout entier, quelle que soit l'heure — et jamais aujourd'hui.
--
-- `leadHours` N'EST PAS SUPPRIMEE : l'image precedente (repli `--repli`) la lit encore, et un
-- SELECT sur une colonne disparue ferait tomber l'API. Elle n'est simplement plus lue.
-- Colonne ajoutee avec un defaut : aucune reecriture de ligne. Tous les liens existants valent
-- J+1, ce qui est exactement la regle demandee pour eux aussi.

ALTER TABLE "installation_booking_links" ADD COLUMN "leadDays" INTEGER NOT NULL DEFAULT 1;
