-- « Owner » plateforme : niveau au-dessus des SUPER_ADMIN, invisible aux autres
-- super-admins. Le compte reste SUPER_ADMIN (pouvoirs inchangés) ; ce flag pilote
-- UNIQUEMENT l'exclusion en lecture (listes utilisateurs, vues d'activité,
-- rapports/coûts IA, masquage de l'auteur d'action).
ALTER TABLE "users" ADD COLUMN "isOwner" BOOLEAN NOT NULL DEFAULT false;

-- Backfill : le compte fondateur devient owner.
UPDATE "users" SET "isOwner" = true WHERE "email" = 'admin@vizyoagency.com';
