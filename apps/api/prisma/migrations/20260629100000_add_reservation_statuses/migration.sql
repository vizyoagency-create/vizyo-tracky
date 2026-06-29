-- Sprint 8 (Palier B) — Statuts de réservation sur l'enum VehicleEventStatus.
-- NB : ADD VALUE doit être committé AVANT toute utilisation de la valeur (cf. migration
-- suivante qui crée la contrainte d'exclusion). D'où la séparation en 2 migrations.
ALTER TYPE "VehicleEventStatus" ADD VALUE IF NOT EXISTS 'REQUESTED';
ALTER TYPE "VehicleEventStatus" ADD VALUE IF NOT EXISTS 'CONFIRMED';
