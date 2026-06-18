-- Sprint 3 : ajoute le rôle « veilleur de nuit » à l'enum UserRole.
-- Rôle restreint : voit les véhicules + coupe/redémarre le moteur (bloque/débloque), rien d'autre.
-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'NIGHT_WATCHMAN';
