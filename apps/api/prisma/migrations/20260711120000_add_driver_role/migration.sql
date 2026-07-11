-- feat/comptes-conducteurs : ajoute le rôle « conducteur » à l'enum UserRole.
-- Rôle restreint : voit ses véhicules ; déverrouille le moteur / active le mode vie privée
-- uniquement si le fleet-admin l'a autorisé sur le périmètre (UserVehicleAccess).
-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'DRIVER';
