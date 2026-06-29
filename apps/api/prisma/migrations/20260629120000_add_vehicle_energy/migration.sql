-- Sprint 10 — Synchro véhicules ↔ planning d'installation.
-- Ajoute le type de carburant au véhicule (place pour recevoir InstallationTask.energy
-- à la pose + via la synchro manuelle). Réutilise l'enum InstallationEnergy déjà créé
-- par la migration du planning d'installation (20260606120000_add_installation_planning).
-- Colonne nullable, sans valeur par défaut : aucun backfill, aucune réécriture de table.

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN "energy" "InstallationEnergy";
