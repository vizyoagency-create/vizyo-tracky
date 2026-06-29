-- Sprint 9 — Métier de la flotte (conditionne l'objectif d'optimisation IA).
-- CHILDREN_TRANSPORT = transport d'enfants, PARCELS = colis, RENTAL = location.
-- Défaut GENERIC : aucune flotte existante impactée.
CREATE TYPE "FleetMetier" AS ENUM ('CHILDREN_TRANSPORT', 'PARCELS', 'RENTAL', 'GENERIC');
ALTER TABLE "fleets" ADD COLUMN     "metier" "FleetMetier" NOT NULL DEFAULT 'GENERIC';
