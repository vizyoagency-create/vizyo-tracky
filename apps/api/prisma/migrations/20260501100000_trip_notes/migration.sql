-- Trajets : note libre + traçabilite du dernier editeur.
--
-- Demande client : permettre d'ajouter un commentaire sur un trajet
-- (ex: "depose Eric au sport"). Pas d'historique des modifications,
-- on garde seulement le dernier auteur via `notesUpdatedById`.
--
-- Permissions cote API : FLEET_ADMIN, FLEET_MANAGER, SUPER_ADMIN.
-- Limite UI : 500 caracteres avec compteur visuel.
-- DB : TEXT non borne — defense en profondeur cote service uniquement.

ALTER TABLE "trips"
  ADD COLUMN "notes"             TEXT,
  ADD COLUMN "notesUpdatedAt"    TIMESTAMP(3),
  ADD COLUMN "notesUpdatedById"  UUID;

ALTER TABLE "trips"
  ADD CONSTRAINT "trips_notesUpdatedById_fkey"
  FOREIGN KEY ("notesUpdatedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMENT ON COLUMN "trips"."notes" IS
  'Note libre rattachee au trajet (max 500 chars cote app, libre cote DB). Demande client : tracer le contexte du trajet ("depose Eric au sport").';
COMMENT ON COLUMN "trips"."notesUpdatedById" IS
  'Dernier User ayant edite la note. NULL si la note n''a jamais ete posee ou si l''auteur a ete supprime (ON DELETE SET NULL).';
