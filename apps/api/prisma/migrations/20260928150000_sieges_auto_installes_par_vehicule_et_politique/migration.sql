-- ── SIÈGES AUTO : INSTALLÉS DANS UN VÉHICULE OU LAISSÉS EN STOCK (2026-09-28, après-midi) ──────
--
-- La migration du matin faisait des sièges un stock de la société. Précision du propriétaire :
-- un siège peut aussi être INSTALLÉ dans une voiture (à bord, prêt) — ou laissé dans le stock.
--
-- `fleets."childSeatsBaby"/"childSeatsChild"` deviennent ce que la société POSSÈDE (inchangés en
-- valeur : 0 partout tant que personne n'a compté). `vehicles."childSeatsBaby"/"childSeatsChild"`
-- = ce qui est installé à bord. Le stock (mobile) = possédés − installés, dérivé, jamais stocké.
--
-- `fleets."childSeatPolicy"` : si le véhicule choisi n'a pas les sièges à bord, le stock peut-il
-- compléter (STOCK_OR_INSTALLED, défaut) ou seuls les sièges installés comptent-ils (INSTALLED_ONLY) ?
CREATE TYPE "ChildSeatPolicy" AS ENUM ('STOCK_OR_INSTALLED', 'INSTALLED_ONLY');

ALTER TABLE "fleets" ADD COLUMN     "childSeatPolicy" "ChildSeatPolicy" NOT NULL DEFAULT 'STOCK_OR_INSTALLED';

ALTER TABLE "vehicles" ADD COLUMN     "childSeatsBaby" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "childSeatsChild" INTEGER NOT NULL DEFAULT 0;
