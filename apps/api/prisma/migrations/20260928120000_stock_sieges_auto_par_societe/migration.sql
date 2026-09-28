-- ── SIÈGES AUTO : UN STOCK PAR SOCIÉTÉ, DEUX TYPES (2026-09-28) ───────────────────────────────
--
-- Jusqu'ici un siège enfant était une CARACTÉRISTIQUE DU VÉHICULE (`vehicles."childSeats"`), à
-- renseigner voiture par voiture et à deviner par l'IA de capacité. Ce n'est pas ainsi qu'une
-- société qui transporte des enfants travaille : elle possède un STOCK de sièges qu'elle installe
-- dans le véhicule retenu. Et il y a DEUX sortes de sièges, jamais interchangeables : un enfant
-- « bébé » ne peut pas aller dans un siège « enfant » — ni l'inverse.
--
-- Deux compteurs sur la société, réglés depuis « Paramètres de l'agenda ». Ce qui reste
-- disponible sur un créneau = stock − sièges engagés par les réservations qui le chevauchent
-- (critères `childSeatsBaby` / `childSeatsChild`). Zéro par défaut : rien n'est promis tant que
-- le client n'a pas compté ses sièges. `vehicles."childSeats"` reste en place, ignoré.
ALTER TABLE "fleets" ADD COLUMN     "childSeatsBaby" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "childSeatsChild" INTEGER NOT NULL DEFAULT 0;
