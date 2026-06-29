-- Sprint 8 (Palier A) — Caractéristiques véhicule pour les critères de réservation
-- (nb de places, sièges enfants/pouponnière, équipements). `features` = tags libres
-- extensibles. Aucune donnée existante impactée (colonnes nullables / défaut vide).
ALTER TABLE "vehicles" ADD COLUMN     "seats" INTEGER;
ALTER TABLE "vehicles" ADD COLUMN     "childSeats" INTEGER;
ALTER TABLE "vehicles" ADD COLUMN     "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
