-- Sprint 2 (Fiabilisation start/stop) — `confirmationExpected` : true si une chute
-- d'ignition est attendable comme preuve reelle de coupure (CUT d'un vehicule en
-- marche). false pour RESTORE ou CUT a l'arret => etat affiche "non verifiable".
-- Additif, backward-compatible. Backfill implicite: false (aucune confirmation
-- presumee pour l'historique).

ALTER TABLE "engine_control_commands" ADD COLUMN "confirmationExpected" BOOLEAN NOT NULL DEFAULT false;
